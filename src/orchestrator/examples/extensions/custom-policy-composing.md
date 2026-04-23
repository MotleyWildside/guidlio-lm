# Example: Composing Policies — Retry Then Fallback

`RetryPolicy` handles transient failures well, but once retries are exhausted it
fails the pipeline. Often you want to keep the pipeline alive by routing to a
fallback step instead — a cached result, a degraded response, or a compensating
action. This example shows how to extend `RetryPolicy` and override its `fail()`
method so that retry exhaustion redirects to a fallback step rather than stopping
the run. The retry logic itself does not need to be reimplemented — `super.fail()`
is called first and only the `fail` transition is intercepted.

**Concepts covered:**
- Extending `RetryPolicy` via `extends` to inherit retry logic
- `fail()` override: call `super.fail()` and intercept the `fail` transition
- `reset()` override: must call `super.reset()` to clear `RetryPolicy`'s attempt counters
- Why `extends` + `super` is preferred over a monolithic policy
- Full pipeline topology showing the fallback branch
- Factory pattern — `RetryThenFallbackPolicy` maintains state, so a factory is required

---

## Policy

```typescript
import {
	RetryPolicy,
	PolicyDecisionInput,
	BaseContext,
	StepOutcome,
	Transition,
} from "guidlio-lm";

type StepOutcomeFailed = Extract<StepOutcome, { type: "failed" }>;

class RetryThenFallbackPolicy<C extends BaseContext> extends RetryPolicy<C> {
	private readonly fallbackStep: string;

	constructor(fallbackStep: string, options?: { maxAttempts?: number; backoffMs?: (attempt: number) => number }) {
		super(options);
		this.fallbackStep = fallbackStep;
	}

	protected override fail(
		outcome: StepOutcomeFailed,
		input: PolicyDecisionInput<C>,
	): Transition {
		// Let RetryPolicy decide first — it may return { type: "retry", ... }
		const transition = super.fail(outcome, input);

		// Only intercept the final give-up decision
		if (transition.type === "fail") {
			// Retries exhausted — redirect to the fallback step instead of failing
			return { type: "goto", stepName: this.fallbackStep };
		}

		// Still retrying — return the retry transition as-is
		return transition;
	}

	override reset(): void {
		// Must call super.reset() — RetryPolicy stores per-step attempt counts in
		// this.attemptCounts (a Map). Without super.reset(), the counters persist
		// from the previous run and the first run's failures consume the next run's budget.
		super.reset();
	}
}
```

`RetryPolicy` tracks attempt counts in `this.attemptCounts`. Omitting
`super.reset()` is a silent bug: sequential runs share the same counter budget
and the second run starts with fewer retries than expected.

---

## Context

```typescript
import { BaseContext } from "guidlio-lm";

interface SummaryContext extends BaseContext {
	documentId: string;
	text: string;
	summary?: string;
	usedFallback?: boolean;
}
```

---

## Steps

```typescript
import { PipelineStep, StepResult, StepRunMeta, ok, failed } from "guidlio-lm";

class PrimaryCallStep extends PipelineStep<SummaryContext> {
	readonly name = "primary-call";

	async run(ctx: SummaryContext, meta: StepRunMeta): Promise<StepResult<SummaryContext>> {
		try {
			const summary = await primaryLLM.summarize(ctx.text, { signal: meta.signal });
			return ok({ ctx: { ...ctx, summary } });
		} catch (err) {
			return failed({
				ctx,
				error: err instanceof Error ? err : new Error(String(err)),
				// Mark as retryable so RetryPolicy attempts it again
				retryable: true,
			});
		}
	}
}

class FallbackCallStep extends PipelineStep<SummaryContext> {
	readonly name = "fallback-call";

	async run(ctx: SummaryContext, meta: StepRunMeta): Promise<StepResult<SummaryContext>> {
		// A cheaper, more reliable model or a cached result
		try {
			const summary = await fallbackLLM.summarize(ctx.text, { signal: meta.signal });
			return ok({ ctx: { ...ctx, summary, usedFallback: true } });
		} catch (err) {
			// Fallback failure is non-retryable — we already tried primary N times
			return failed({
				ctx,
				error: err instanceof Error ? err : new Error(String(err)),
				retryable: false,
			});
		}
	}
}

class FinalizeStep extends PipelineStep<SummaryContext> {
	readonly name = "finalize";

	async run(ctx: SummaryContext, _meta: StepRunMeta): Promise<StepResult<SummaryContext>> {
		await store.save(ctx.documentId, ctx.summary, { fallback: ctx.usedFallback });
		return ok({ ctx });
	}
}
```

---

## Wiring

```typescript
import { GuidlioOrchestrator } from "guidlio-lm";

const orchestrator = new GuidlioOrchestrator<SummaryContext>({
	steps: [
		new PrimaryCallStep(),
		new FallbackCallStep(),
		new FinalizeStep(),
	],
	// Factory required: RetryThenFallbackPolicy inherits RetryPolicy's mutable
	// attempt counters, so a new instance per run prevents cross-run leakage.
	policy: () => new RetryThenFallbackPolicy("fallback-call", {
		maxAttempts: 3,
		backoffMs: (attempt) => 200 * 2 ** (attempt - 1),
	}),
});
```

Pipeline shape when primary fails after all retries:

```
primary-call  ──retry──►  primary-call  ──retry──►  primary-call
              (attempt 1)                (attempt 2)  (attempt 3 — exhausted)
              ──goto:fallback-call──►  fallback-call  ──next──►  finalize
```

---

## Running

```typescript
const result = await orchestrator.run({
	traceId: "sum-001",
	documentId: "doc-42",
	text: "Long article text...",
});

if (result.status === "ok") {
	console.log("Summary:", result.ctx.summary);
	if (result.ctx.usedFallback) {
		console.warn("Primary LLM was unavailable; fallback was used");
	}
} else {
	// Both primary (after retries) and fallback failed
	console.error("All summarization paths failed:", result.error.message);
}
```

---

## Why extend rather than rewrite

Writing a policy that both retries and redirects from scratch means duplicating
the attempt-counter bookkeeping already in `RetryPolicy`. Every change to retry
semantics (e.g. per-step limits, jitter) would need to be reflected in two places.
`extends` + `super.fail()` gives you a clean interception point: change the parent,
the child inherits it automatically.

---

## What to change next

- Understand `RetryPolicy` in isolation before composing it: `../retry-with-backoff.md`
- Add a circuit breaker that trips when retries keep exhausting: `./custom-policy-circuit-breaker.md`
