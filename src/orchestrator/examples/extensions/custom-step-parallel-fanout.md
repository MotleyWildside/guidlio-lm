# Example: Step with Parallel Fan-Out

Some processing tasks are embarrassingly parallel: summarize ten documents, embed
a batch of paragraphs, translate a set of strings. Running them sequentially wastes
wall-clock time. This example shows how to fire N `GuidlioLMService` calls in
parallel inside a single step using `Promise.all`, share a single `AbortSignal`
across all of them so one cancellation aborts the batch, and reduce the results
into a single context update.

**Concepts covered:**
- `Promise.all()` inside a step to run N LLM calls concurrently
- Sharing `meta.signal` with every call for coordinated cancellation
- Catching a `Promise.all` rejection and returning `failed({ retryable: true })`
- Reducing the results array into a `ctx.summaries` field
- Why individual promises keep running briefly after `Promise.all` rejects (and why that is acceptable)

---

## Context

```typescript
import { BaseContext } from "guidlio-lm";

interface SummarizeContext extends BaseContext {
	documents: Array<{ id: string; text: string }>;
	summaries?: Array<{ id: string; summary: string }>;
}
```

---

## Step

```typescript
import {
	PipelineStep,
	StepResult,
	StepRunMeta,
	ok,
	failed,
	GuidlioLMService,
	LLMTransientError,
} from "guidlio-lm";

class ParallelSummarizeStep extends PipelineStep<SummarizeContext> {
	readonly name = "parallel-summarize";

	private readonly llm: GuidlioLMService;

	constructor(llm: GuidlioLMService) {
		super();
		this.llm = llm;
	}

	async run(
		ctx: SummarizeContext,
		meta: StepRunMeta,
	): Promise<StepResult<SummarizeContext>> {
		if (ctx.documents.length === 0) {
			return ok({ ctx: { ...ctx, summaries: [] } });
		}

		let rawResults: Array<{ text: string }>;

		try {
			// All N calls start simultaneously. Promise.all rejects as soon as
			// any single call rejects — the other in-flight calls keep running
			// until they hit their next signal check, then abort cleanly.
			rawResults = await Promise.all(
				ctx.documents.map((doc) =>
					this.llm.callText({
						model: "gpt-4o-mini",
						messages: [
							{
								role: "user",
								content: `Summarize the following in one sentence:\n\n${doc.text}`,
							},
						],
						// Share the same signal: if the orchestrator run is cancelled,
						// all in-flight LLM HTTP requests are cancelled together
						signal: meta.signal,
						traceId: ctx.traceId,
					}),
				),
			);
		} catch (err) {
			// Any single call failing fails the whole batch.
			// LLMTransientError (rate-limit, 503) is worth retrying.
			const retryable = err instanceof LLMTransientError;
			return failed({
				ctx,
				error: err instanceof Error ? err : new Error(String(err)),
				retryable,
			});
		}

		// Zip results back with their document ids
		const summaries = ctx.documents.map((doc, i) => ({
			id: doc.id,
			summary: rawResults[i].text,
		}));

		return ok({ ctx: { ...ctx, summaries } });
	}
}
```

---

## Wiring

```typescript
import { GuidlioOrchestrator, GuidlioLMService, RetryPolicy } from "guidlio-lm";

const llm = new GuidlioLMService({
	providers: [
		// ... provider config
	],
});

class StoreSummariesStep extends PipelineStep<SummarizeContext> {
	readonly name = "store-summaries";
	async run(ctx: SummarizeContext, _meta: StepRunMeta): Promise<StepResult<SummarizeContext>> {
		await db.saveBatch(ctx.summaries ?? []);
		return ok({ ctx });
	}
}

const orchestrator = new GuidlioOrchestrator<SummarizeContext>({
	steps: [
		new ParallelSummarizeStep(llm),
		new StoreSummariesStep(),
	],
	// On LLMTransientError the whole batch is retried. This is correct for
	// a fan-out step: partial completion isn't tracked, so retry means restart.
	policy: () => new RetryPolicy({
		maxAttempts: 3,
		backoffMs: (attempt) => 1_000 * attempt,
	}),
	// Give the batch enough time; N parallel calls still share wall-clock budget
	stepTimeoutMs: 30_000,
});
```

---

## Running

```typescript
const result = await orchestrator.run({
	traceId: "batch-001",
	documents: [
		{ id: "d1", text: "The quick brown fox jumps over the lazy dog." },
		{ id: "d2", text: "To be or not to be, that is the question." },
		{ id: "d3", text: "It was the best of times, it was the worst of times." },
	],
});

if (result.status === "ok") {
	for (const { id, summary } of result.ctx.summaries ?? []) {
		console.log(`${id}: ${summary}`);
	}
} else {
	console.error("Batch failed:", result.error.message);
}
```

---

## Cancellation behaviour

When `meta.signal` fires mid-flight, `Promise.all` rejects with an `AbortError`
from whichever promise checked the signal first. The remaining in-flight promises
are not forcibly stopped — JavaScript promises are not cancellable. They will run
until they hit the next `await`, at which point the HTTP client (undici, node-fetch,
or the built-in `fetch`) checks the signal and rejects.

This is the correct trade-off: the step returns `failed()` immediately to the
orchestrator (which then handles the abort), while the remaining HTTP requests
drain in the background and are cleaned up by the HTTP client. No clean-up code
is needed in the step.

---

## Partial failure strategy

`Promise.all` is all-or-nothing: one rejection fails the batch. For a use case
where partial results are acceptable, use `Promise.allSettled` instead:

```typescript
const settled = await Promise.allSettled(
	ctx.documents.map((doc) => this.llm.callText({ ... })),
);

const summaries = settled.flatMap((r, i) =>
	r.status === "fulfilled"
		? [{ id: ctx.documents[i].id, summary: r.value.text }]
		: [], // skip failed documents
);

// If too many failed, treat as a retryable error
const failCount = settled.filter((r) => r.status === "rejected").length;
if (failCount > ctx.documents.length / 2) {
	return failed({ ctx, error: new Error("More than half of documents failed"), retryable: true });
}
return ok({ ctx: { ...ctx, summaries } });
```

---

## What to change next

- Wrap a single LLM call with full error translation: `./custom-step-llm-call.md`
- Apply the same fan-out pattern to HTTP calls: `./custom-step-http-call.md`
