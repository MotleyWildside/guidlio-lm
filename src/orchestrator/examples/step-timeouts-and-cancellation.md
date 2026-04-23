# Step Timeouts and Cancellation

In production pipelines, steps that call external services can hang indefinitely. `stepTimeoutMs` gives each step a hard wall-clock cap. `meta.signal` lets you propagate that deadline into the async work inside the step so the underlying I/O is also cancelled rather than left running in the background.

**Concepts covered:**
- `stepTimeoutMs` on the orchestrator config: races the step's Promise
- What happens when the timeout fires: non-retryable `failed` outcome
- `meta.signal` for cooperative cancellation of in-step async work
- Difference between a timeout (non-retryable) and a step-raised transient error (retryable)
- `PipelineRunOptions.signal` for aborting the entire run from outside

---

## stepTimeoutMs

Set `stepTimeoutMs` on the orchestrator config. The orchestrator races the step's `run()` Promise against a timer. If the timer fires first, the outcome is:

```typescript
{ type: "failed", retryable: false }
```

`RetryPolicy` will **not** retry a timed-out step because `retryable` is `false`. The pipeline ends with `status: "failed"`.

```typescript
import {
	GuidlioOrchestrator,
	RetryPolicy,
	PipelineStep,
	StepResult,
	StepRunMeta,
	ok,
	failed,
	BaseContext,
} from "guidlio-lm";

interface FetchContext extends BaseContext {
	url: string;
	responseBody?: string;
}

class FetchStep extends PipelineStep<FetchContext> {
	readonly name = "fetch";

	async run(ctx: FetchContext, meta: StepRunMeta): Promise<StepResult<FetchContext>> {
		try {
			// Pass meta.signal so fetch is cancelled when the step timeout fires
			const response = await fetch(ctx.url, { signal: meta.signal });
			if (!response.ok) {
				return failed({
					ctx,
					error: new Error(`HTTP ${response.status}`),
					// 5xx is transient — RetryPolicy will retry up to maxAttempts
					retryable: response.status >= 500,
					statusCode: response.status,
				});
			}
			const body = await response.text();
			return ok({ ctx: { ...ctx, responseBody: body } });
		} catch (err) {
			// fetch throws a DOMException named "AbortError" when the signal fires
			if (err instanceof Error && err.name === "AbortError") {
				return failed({
					ctx,
					error: new Error("Step timed out"),
					// Keep retryable: false — consistent with what stepTimeoutMs sets
					retryable: false,
				});
			}
			return failed({
				ctx,
				error: err instanceof Error ? err : new Error(String(err)),
				retryable: true,
			});
		}
	}
}

const orchestrator = new GuidlioOrchestrator<FetchContext>({
	steps: [new FetchStep()],
	policy: () => new RetryPolicy({ maxAttempts: 3 }),
	// Each step gets at most 4 seconds; timeout = non-retryable failed outcome
	stepTimeoutMs: 4_000,
});
```

---

## meta.signal: cooperative cancellation

`stepTimeoutMs` races the Promise, but the step's async work keeps running in the background unless it checks the signal. Pass `meta.signal` into every long-running call inside the step:

```typescript
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";

interface SummarizeContext extends BaseContext {
	text: string;
	summary?: string;
}

const registry = new PromptRegistry();

registry.register({
	promptId: "summarize",
	version: 1,
	userPrompt: "Summarize: {text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});

class SummarizeStep extends PipelineStep<SummarizeContext> {
	readonly name = "summarize";

	async run(ctx: SummarizeContext, meta: StepRunMeta): Promise<StepResult<SummarizeContext>> {
		try {
			// meta.signal is aborted when stepTimeoutMs fires OR when
			// PipelineRunOptions.signal is aborted from outside
			const result = await llm.callText({
				promptId: "summarize",
				variables: { text: ctx.text },
				signal: meta.signal,
			});
			return ok({ ctx: { ...ctx, summary: result.text } });
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				return failed({ ctx, error: new Error("LLM call cancelled"), retryable: false });
			}
			return failed({ ctx, error: err instanceof Error ? err : new Error(String(err)), retryable: true });
		}
	}
}
```

Without `signal: meta.signal`, the LLM HTTP request keeps running after the timeout fires — consuming network resources and potentially incurring token costs even though the pipeline already failed.

---

## Timeout vs transient error

The distinction matters for `RetryPolicy`:

| Situation | `retryable` | `RetryPolicy` behavior |
| :--- | :--- | :--- |
| `stepTimeoutMs` fires | `false` (set by orchestrator) | Does not retry |
| Step catches a network error and returns `retryable: true` | `true` | Retries up to `maxAttempts` |
| Step returns `retryable: false` explicitly | `false` | Does not retry |

If you want timeouts to be retryable (e.g., each retry gets a fresh 4 s window), override the `retryIf` predicate in `RetryPolicy`:

```typescript
import type { StepOutcomeFailed } from "guidlio-lm";

const orchestrator = new GuidlioOrchestrator<FetchContext>({
	steps: [new FetchStep()],
	policy: () =>
		new RetryPolicy({
			maxAttempts: 3,
			// Retry timeouts — each attempt gets a fresh stepTimeoutMs window
			retryIf: (outcome: StepOutcomeFailed) =>
				outcome.retryable === true || outcome.error.message === "Step timed out",
		}),
	stepTimeoutMs: 4_000,
});
```

---

## Aborting the entire run from outside

Pass a signal to `orchestrator.run()` via `PipelineRunOptions`. The orchestrator checks this signal before starting each step. If aborted, it throws `PipelineAbortedError` (returned as `result.error`, not thrown from `run()`). The same signal is also forwarded to `meta.signal` inside each step, so in-flight async work is cancelled too.

```typescript
import { PipelineAbortedError } from "guidlio-lm";

const controller = new AbortController();

// Abort the pipeline when the HTTP client disconnects
req.on("close", () => controller.abort());

const result = await orchestrator.run(
	{ traceId: "req-abc", url: "https://api.example.com/data" },
	{ signal: controller.signal },
);

if (result.status === "failed" && result.error instanceof PipelineAbortedError) {
	// statusCode 499 — client closed request (standard nginx convention)
	console.log("Run aborted, status:", result.error.statusCode); // 499
	// result.ctx reflects the last successfully completed step
	console.log("Partial context:", result.ctx);
}
```

---

## What to change next

- [retry-with-backoff.md](./retry-with-backoff.md) — full `RetryPolicy` reference including `backoffMs`, `retryIf`, and the pitfall of sharing a stateful policy instance
- [abort-from-outside.md](./abort-from-outside.md) — detailed patterns for aborting a pipeline from an HTTP request handler or parent `AbortController`
