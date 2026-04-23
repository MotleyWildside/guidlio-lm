# Example: Step That Wraps an LLM Call

`GuidlioLMService` errors are typed — `LLMTransientError` for recoverable
failures, `LLMPermanentError` / `LLMParseError` / `LLMSchemaError` for ones that
won't resolve on a retry. A step that calls the LLM must translate those typed
errors into `StepOutcome` semantics so the orchestrator's retry policy can act on
them. This example shows the canonical translation pattern: catch each error class
and return the appropriate `failed()` with a `retryable` flag. The policy then
handles retries uniformly without knowing anything about HTTP status codes or JSON
parse failures.

**Concepts covered:**
- Accepting `GuidlioLMService` as a constructor dependency
- Passing `meta.signal` to `callJSON()` for cooperative cancellation
- Translating `LLMTransientError` → `failed({ retryable: true })`
- Translating `LLMPermanentError`, `LLMSchemaError`, `LLMParseError` → `failed({ retryable: false })`
- Placing the parsed result in ctx and returning `ok()`
- Why this translation layer is the only integration point between LLM errors and the pipeline

---

## Context

```typescript
import { BaseContext } from "guidlio-lm";
import { z } from "zod";

export const ClassificationSchema = z.object({
	category: z.enum(["spam", "ham", "uncertain"]),
	confidence: z.number().min(0).max(1),
	reason: z.string(),
});

export type Classification = z.infer<typeof ClassificationSchema>;

export interface ClassifyContext extends BaseContext {
	messageId: string;
	text: string;
	classification?: Classification;
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
	LLMPermanentError,
	LLMSchemaError,
	LLMParseError,
} from "guidlio-lm";
import { ClassifyContext, ClassificationSchema } from "./context";

class ClassifyStep extends PipelineStep<ClassifyContext> {
	readonly name = "classify";

	private readonly llm: GuidlioLMService;

	constructor(llm: GuidlioLMService) {
		super();
		this.llm = llm;
	}

	async run(ctx: ClassifyContext, meta: StepRunMeta): Promise<StepResult<ClassifyContext>> {
		try {
			const result = await this.llm.callJSON({
				model: "gpt-4o-mini",
				schema: ClassificationSchema,
				messages: [
					{
						role: "user",
						content: `Classify the following message.\n\n${ctx.text}`,
					},
				],
				// Forward the orchestrator's AbortSignal so cancellation propagates
				// into the underlying HTTP request
				signal: meta.signal,
				traceId: ctx.traceId, // correlate LLM logs with this pipeline run
			});

			// result.data is typed as Classification — place it on ctx
			return ok({ ctx: { ...ctx, classification: result.data } });
		} catch (err) {
			if (err instanceof LLMTransientError) {
				// Rate-limit, upstream 503, network timeout — worth retrying
				return failed({ ctx, error: err, retryable: true });
			}

			if (
				err instanceof LLMPermanentError ||
				err instanceof LLMParseError ||
				err instanceof LLMSchemaError
			) {
				// Bad request, invalid API key, or the model returned unparseable JSON —
				// none of these will resolve by retrying the same input
				return failed({ ctx, error: err, retryable: false });
			}

			// Unexpected error — treat as non-retryable to avoid masking bugs
			const wrapped = err instanceof Error ? err : new Error(String(err));
			return failed({ ctx, error: wrapped, retryable: false });
		}
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

class StoreResultStep extends PipelineStep<ClassifyContext> {
	readonly name = "store-result";
	async run(ctx: ClassifyContext, _meta: StepRunMeta): Promise<StepResult<ClassifyContext>> {
		await db.save(ctx.messageId, ctx.classification);
		return ok({ ctx });
	}
}

const orchestrator = new GuidlioOrchestrator<ClassifyContext>({
	steps: [
		new ClassifyStep(llm),   // inject the shared LLM service
		new StoreResultStep(),
	],
	// RetryPolicy retries when retryable === true — i.e. on LLMTransientError only
	policy: () => new RetryPolicy({ maxAttempts: 3, backoffMs: (n) => 500 * n }),
});
```

---

## Running

```typescript
const result = await orchestrator.run({
	traceId: "msg-001",
	messageId: "m-abc",
	text: "Congratulations! You have won a prize.",
});

if (result.status === "ok") {
	const { category, confidence } = result.ctx.classification!;
	console.log(`${category} (${(confidence * 100).toFixed(1)}%)`);
	// "spam (97.3%)"
} else {
	console.error("Classification failed:", result.error.message);
	// result.error.stepName === "classify"
}
```

---

## The translation contract

| LLM error | `retryable` | Why |
|---|---|---|
| `LLMTransientError` | `true` | Rate-limit or upstream blip — retry is meaningful |
| `LLMPermanentError` | `false` | Bad request, auth error — same input will fail again |
| `LLMParseError` | `false` | Model returned non-JSON — retry rarely fixes this |
| `LLMSchemaError` | `false` | JSON was valid but failed Zod validation — schema mismatch |

The policy (e.g. `RetryPolicy`) reads `retryable` and handles the retry budget.
The step does not need to count retries, sleep, or inspect `meta.attempt` for this
logic — that separation is the point.

---

## What to change next

- Apply the same pattern to an HTTP dependency: `./custom-step-http-call.md`
- Fan out multiple LLM calls in parallel inside a single step: `./custom-step-parallel-fanout.md`
