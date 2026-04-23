# Example: Circuit-Breaker Policy

When a downstream dependency is degraded, retrying every request makes things worse.
A circuit breaker counts consecutive failures and, once a threshold is reached,
short-circuits all subsequent run attempts — returning a degraded result immediately
without touching the dependency — until a cooldown period elapses and the circuit
closes again. This example shows how to extend `DefaultPolicy` with persistent
cross-run breaker state while keeping per-run orchestrator isolation intact.

**Concepts covered:**
- Extending `DefaultPolicy` with an `ok()` override to reset the failure counter on success
- `fail()` override that opens the circuit after N consecutive failures
- Early-exit in `decide()` when the circuit is open — transitions directly to `degrade`
- Breaker state that intentionally outlives a single `run()` call
- The policy factory pattern and why the breaker object must live outside the factory
- Surfacing `result.degraded` at the call site

---

## Shared breaker state

The breaker is a plain object — not the policy class itself. This separation is
the key: the factory creates a fresh policy instance per run (for isolation), but
all those instances reference the same breaker object (for continuity).

```typescript
// breaker.ts — create once at application startup, share across orchestrator instances

export interface BreakerState {
	consecutiveFailures: number;
	openUntil: number; // Unix ms timestamp; 0 = closed
}

export function makeBreakerState(): BreakerState {
	return { consecutiveFailures: 0, openUntil: 0 };
}
```

---

## Policy

```typescript
import {
	DefaultPolicy,
	PolicyDecisionInput,
	PolicyDecisionOutput,
	BaseContext,
	StepOutcome,
} from "guidlio-lm";

// Treat the failed outcome type inline — no import needed for the literal shape
type StepOutcomeFailed = Extract<StepOutcome, { type: "failed" }>;

interface BreakerOptions {
	threshold: number;   // consecutive failures needed to open the circuit
	cooldownMs: number;  // how long to keep the circuit open before retrying
}

class CircuitBreakerPolicy<C extends BaseContext> extends DefaultPolicy<C> {
	private readonly state: BreakerState;
	private readonly threshold: number;
	private readonly cooldownMs: number;

	constructor(state: BreakerState, options: BreakerOptions) {
		super();
		this.state = state;
		this.threshold = options.threshold;
		this.cooldownMs = options.cooldownMs;
	}

	// decide() is the first thing called per step — check the circuit before anything else
	override decide(
		input: PolicyDecisionInput<C>,
	): PolicyDecisionOutput<C> | Promise<PolicyDecisionOutput<C>> {
		if (Date.now() < this.state.openUntil) {
			const cooldownUntil = new Date(this.state.openUntil).toISOString();
			return {
				transition: {
					type: "degrade",
					reason: `circuit open — cooldown until ${cooldownUntil}`,
				},
			};
		}
		return super.decide(input);
	}

	protected override fail(
		outcome: StepOutcomeFailed,
		input: PolicyDecisionInput<C>,
	) {
		this.state.consecutiveFailures += 1;

		if (this.state.consecutiveFailures >= this.threshold) {
			// Open the circuit — subsequent decide() calls will degrade immediately
			this.state.openUntil = Date.now() + this.cooldownMs;
			this.state.consecutiveFailures = 0; // reset counter; the circuit is now the guard
		}

		return super.fail(outcome, input);
	}

	protected override ok(
		outcome: Extract<StepOutcome, { type: "ok" }>,
		input: PolicyDecisionInput<C>,
	) {
		// A successful run means the dependency is healthy — reset the counter
		this.state.consecutiveFailures = 0;
		return super.ok(outcome, input);
	}

	override reset(): void {
		// Call super to clear any DefaultPolicy internal state across runs
		super.reset();
		// Do NOT touch this.state here — breaker state intentionally persists across runs
	}
}
```

---

## Context and steps

```typescript
import { BaseContext, PipelineStep, StepResult, StepRunMeta, ok, failed } from "guidlio-lm";

interface PaymentContext extends BaseContext {
	orderId: string;
	chargeResult?: { transactionId: string };
}

class ChargeStep extends PipelineStep<PaymentContext> {
	readonly name = "charge";

	async run(ctx: PaymentContext, _meta: StepRunMeta): Promise<StepResult<PaymentContext>> {
		try {
			const result = await paymentGateway.charge(ctx.orderId);
			return ok({ ctx: { ...ctx, chargeResult: result } });
		} catch (err) {
			return failed({
				ctx,
				error: err instanceof Error ? err : new Error(String(err)),
				retryable: true,
			});
		}
	}
}

class RecordStep extends PipelineStep<PaymentContext> {
	readonly name = "record";

	async run(ctx: PaymentContext, _meta: StepRunMeta): Promise<StepResult<PaymentContext>> {
		await db.saveCharge(ctx.chargeResult);
		return ok({ ctx });
	}
}
```

---

## Wiring

The breaker object is created once at module load. The policy factory captures it
by reference — every `run()` gets a fresh `CircuitBreakerPolicy` instance, but
they all read and write the same `state` object.

```typescript
import { GuidlioOrchestrator } from "guidlio-lm";
import { makeBreakerState } from "./breaker";

// Created once — lives for the lifetime of the process
const breaker = makeBreakerState();

const orchestrator = new GuidlioOrchestrator<PaymentContext>({
	steps: [new ChargeStep(), new RecordStep()],

	// Factory: each run() receives a new policy instance,
	// but all instances share the same `breaker` object.
	// If you passed `new CircuitBreakerPolicy(...)` directly (no factory), a single
	// instance would be reused and reset() would be called between runs — which is
	// also correct for sequential use, but unsafe for concurrent runs.
	policy: () => new CircuitBreakerPolicy(breaker, { threshold: 3, cooldownMs: 30_000 }),
});
```

---

## Running

```typescript
// Normal operation
const r1 = await orchestrator.run({ traceId: "pay-001", orderId: "order-A" });
if (r1.status === "ok") {
	console.log("Charged:", r1.ctx.chargeResult?.transactionId);
}

// After 3 consecutive failures the circuit opens.
// Subsequent runs skip the charge step entirely and return degraded.
const r2 = await orchestrator.run({ traceId: "pay-004", orderId: "order-D" });
if (r2.status === "ok" && r2.degraded) {
	console.warn("Payment skipped — circuit open:", r2.degraded.reason);
	// Caller can queue the order for later retry or show a maintenance message
}
```

The `degraded` field is only present on `status === "ok"` results. A degraded
pipeline did not fail — it completed with reduced functionality. Distinguish it
from `status === "failed"` where no meaningful result is available.

---

## What to change next

- Add retry logic before the circuit opens: `../retry-with-backoff.md`
- Route to a fallback step when retries are exhausted instead of failing: `./custom-policy-composing.md`
