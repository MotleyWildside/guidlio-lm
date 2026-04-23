# Aborting a Pipeline from the Outside

Pass an `AbortSignal` to `orchestrator.run()` to stop a pipeline cleanly from the caller — for example when an HTTP client disconnects or a job scheduler cancels the work. The pipeline stops before its next step, and the final context from the last completed step is still available in the result.

**Concepts covered:**
- `PipelineRunOptions.signal` — forwarded to each step via `meta.signal`
- `PipelineAbortedError` — the error type set on `result.error` when the signal fires
- `result.ctx` after abort — reflects the last completed step's output, not an empty context
- Connecting `signal` to real async work via `meta.signal` inside step code
- HTTP request-scoped cancellation pattern

---

## Basic abort

```typescript
import {
	GuidlioOrchestrator,
	PipelineStep,
	StepResult,
	StepRunMeta,
	ok,
	BaseContext,
	PipelineAbortedError,
} from "guidlio-lm";

interface WorkCtx extends BaseContext {
	step1Done?: boolean;
	step2Done?: boolean;
	step3Done?: boolean;
}

class SlowStep extends PipelineStep<WorkCtx> {
	constructor(
		readonly name: string,
		private field: keyof WorkCtx,
		private delayMs: number,
	) {
		super();
	}

	async run(ctx: WorkCtx, meta: StepRunMeta): Promise<StepResult<WorkCtx>> {
		// Check before doing expensive work
		if (meta.signal?.aborted) {
			return { ctx, outcome: { type: "failed", error: new Error("Aborted"), retryable: false } };
		}
		await delay(this.delayMs, meta.signal);
		return ok({ ctx: { ...ctx, [this.field]: true } });
	}
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
		}, { once: true });
	});
}

const orchestrator = new GuidlioOrchestrator<WorkCtx>({
	steps: [
		new SlowStep("step-1", "step1Done", 100),
		new SlowStep("step-2", "step2Done", 5_000), // long step
		new SlowStep("step-3", "step3Done", 100),
	],
});
```

---

## Running with a signal

```typescript
const controller = new AbortController();

// Abort after 500 ms — step-2 will be interrupted
setTimeout(() => controller.abort(new Error("deadline exceeded")), 500);

const result = await orchestrator.run(
	{ traceId: "run-001" },
	{ signal: controller.signal },
);

if (result.status === "failed") {
	console.log(result.error instanceof PipelineAbortedError); // true
	console.log(result.error.statusCode);                      // 499
	console.log(result.error.message);                        // "Pipeline aborted at step 'step-2'"

	// ctx reflects the last completed step — step-1 ran, step-2 was interrupted
	console.log(result.ctx.step1Done); // true
	console.log(result.ctx.step2Done); // undefined — never finished
	console.log(result.ctx.step3Done); // undefined — never started
}
```

---

## HTTP request-scoped cancellation

Wire the `AbortController` to the HTTP connection lifecycle so in-flight pipeline work is cancelled when the client disconnects.

```typescript
import type { Request, Response } from "express";

async function handleSummarize(req: Request, res: Response): Promise<void> {
	const controller = new AbortController();

	// Cancel the pipeline if the client disconnects before we respond
	req.on("close", () => controller.abort(new Error("client disconnected")));

	const result = await orchestrator.run(
		{
			traceId: req.headers["x-trace-id"] as string ?? crypto.randomUUID(),
			text: req.body.text as string,
		},
		{ signal: controller.signal },
	);

	if (result.status === "ok") {
		res.json({ summary: result.ctx.summary });
	} else if (result.error instanceof PipelineAbortedError) {
		// Client already gone — nothing to send; just log
		req.log?.info("pipeline aborted — client disconnected");
	} else {
		res.status(500).json({ error: result.error.message });
	}
}
```

---

## Signal propagation inside steps

The signal is forwarded to each step via `meta.signal`. Pass it into every async operation that supports it:

```typescript
import { GuidlioLMService, LLMTransientError } from "guidlio-lm";

class SummarizeStep extends PipelineStep<SummarizeCtx> {
	readonly name = "summarize";
	constructor(private llm: GuidlioLMService) { super(); }

	async run(ctx: SummarizeCtx, meta: StepRunMeta): Promise<StepResult<SummarizeCtx>> {
		try {
			const result = await this.llm.callText({
				promptId: "summarize",
				variables: { text: ctx.text },
				traceId: ctx.traceId,
				signal: meta.signal, // ← propagate signal into the LLM call
			});
			return ok({ ctx: { ...ctx, summary: result.text } });
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				// Surface as non-retryable — the pipeline abort handler picks this up
				return { ctx, outcome: { type: "failed", error: err as Error, retryable: false } };
			}
			return { ctx, outcome: { type: "failed", error: err as Error, retryable: err instanceof LLMTransientError } };
		}
	}
}
```

---

## What happens when the signal fires

The orchestrator checks the signal **between steps** (not mid-step). If the signal fires while step N is running, the pipeline continues until step N finishes, then checks and throws `PipelineAbortedError` before starting step N+1. For mid-step cancellation, the step must cooperate by checking `meta.signal` and/or passing it to async calls.

| Fired when | Pipeline behaviour |
| :--- | :--- |
| Before any step starts | Throws immediately, `ctx` is the initial context |
| While step N is running | Step N finishes, then abort check fires before step N+1 |
| After last step finishes | `run()` completes normally — abort arrived too late |

---

## What to change next

- [step-timeouts-and-cancellation.md](./step-timeouts-and-cancellation.md) — per-step wall-clock timeouts and cooperative cancellation
- [retry-with-backoff.md](../retry-with-backoff.md) — `AbortSignal` propagation through retry delays
