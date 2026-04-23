# Concurrent Runs and the Policy Factory Pattern

When two or more `orchestrator.run()` calls execute at the same time, any mutable state stored on a shared policy instance is shared between them. The fix is always the same: pass a factory function instead of an instance so each run gets its own isolated policy.

**Concepts covered:**
- Why `RetryPolicy` stores mutable state and why that matters for concurrent runs
- The state-leak bug demonstrated with sequential then concurrent pseudocode
- The factory pattern `policy: () => new RetryPolicy(...)` as the correct solution
- Which built-in policies are stateless and safe to share
- `policy.reset()` — what it does and when it is called

---

## The problem

`RetryPolicy` tracks how many times each step has been attempted in an internal `Map<string, number>`. If two runs share the same instance, their attempt counts accumulate in the same map.

```typescript
import { GuidlioOrchestrator, RetryPolicy, PipelineStep, StepResult, StepRunMeta, ok, failed, BaseContext } from "guidlio-lm";

interface Ctx extends BaseContext {
	data?: string;
}

class Flaky extends PipelineStep<Ctx> {
	readonly name = "flaky";
	async run(ctx: Ctx, meta: StepRunMeta): Promise<StepResult<Ctx>> {
		if (meta.attempt < 2) {
			return failed({ ctx, error: new Error("transient"), retryable: true });
		}
		return ok({ ctx: { ...ctx, data: "done" } });
	}
}

// BUG: shared instance — attempt counters leak between concurrent runs
const sharedPolicy = new RetryPolicy<Ctx>({ maxAttempts: 3 });

const orchestrator = new GuidlioOrchestrator<Ctx>({
	steps: [new Flaky()],
	policy: sharedPolicy, // ← wrong for concurrent use
});
```

**Sequential runs** are safe because `reset()` is called at the start of each `run()`, which clears the counters:

```typescript
// Sequential: fine — reset() clears counters before run B starts
await orchestrator.run({ traceId: "run-A" });
await orchestrator.run({ traceId: "run-B" }); // reset() fires before B starts
```

**Concurrent runs** are not safe — both run calls are in flight simultaneously, so `reset()` from one run races with the attempt counter updates of the other:

```typescript
// Concurrent: BROKEN — run B's reset() may clear counters mid-flight in run A
const [a, b] = await Promise.all([
	orchestrator.run({ traceId: "run-A" }),
	orchestrator.run({ traceId: "run-B" }), // reset() clears A's counters at an arbitrary point
]);
```

---

## The fix: factory pattern

Pass a function instead of an instance. The orchestrator calls the factory once per `run()` invocation, so each concurrent run gets a fresh policy with its own isolated state.

```typescript
const orchestrator = new GuidlioOrchestrator<Ctx>({
	steps: [new Flaky()],
	// factory — each run() creates a new RetryPolicy instance
	policy: () => new RetryPolicy<Ctx>({ maxAttempts: 3 }),
});

// Concurrent runs are now safe — each has isolated attempt counters
const [a, b] = await Promise.all([
	orchestrator.run({ traceId: "run-A" }),
	orchestrator.run({ traceId: "run-B" }),
]);
```

The orchestrator still calls `policy.reset()` at the start of each run. For a factory-created instance this is a no-op because the instance is already fresh.

---

## What `reset()` is for

`reset()` exists so that **stateful policies used as instances** (not factories) can clean up between sequential runs. `RetryPolicy.reset()` calls `this.attemptCounts.clear()`.

If you write a custom policy with state, always implement `reset()` and call `super.reset()`:

```typescript
import { DefaultPolicy, PolicyDecisionInput, PolicyDecisionOutput, BaseContext } from "guidlio-lm";

class CountingPolicy<C extends BaseContext> extends DefaultPolicy<C> {
	private callCount = 0;

	override decide(input: PolicyDecisionInput<C>): PolicyDecisionOutput<C> {
		this.callCount++;
		return super.decide(input);
	}

	override reset(): void {
		super.reset();
		this.callCount = 0; // clear between runs if reusing as instance
	}
}
```

---

## Which policies are safe to share

| Policy | Mutable state | Safe to share as instance |
| :--- | :--- | :--- |
| `DefaultPolicy` | None | Yes |
| `RedirectRoutingPolicy` | None | Yes |
| `RetryPolicy` | Per-step attempt counters | Sequential only; factory for concurrent |
| Any custom policy with `Map`, counters, flags | Yes | Depends — use factory to be safe |

**Rule of thumb:** if the policy has any field initialised in the constructor that changes during `decide()`, use a factory.

---

## What to change next

- [retry-with-backoff.md](../retry-with-backoff.md) — `RetryPolicy` options and backoff formula
- [custom-policy-circuit-breaker.md](./custom-policy-circuit-breaker.md) — breaker state that intentionally outlives a single run (shared instance with a separate state object)
