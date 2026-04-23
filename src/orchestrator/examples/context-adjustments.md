# Context Adjustments

A policy can mutate the pipeline context as part of a transition decision. This keeps steps pure — they return an outcome describing what happened, not where to go — while giving the policy full control over both routing and context state changes.

**Concepts covered:**
- Three adjustment modes: `none`, `patch`, `override`
- When to use `patch`: incrementing counters or appending to arrays during a transition
- When to use `override`: handing the policy a fully-computed new context
- Why context mutation belongs in the policy, not the step
- A concrete `decide()` that returns both a `goto` transition and a `patch` adjustment

---

## The three adjustment modes

```typescript
// none — context passes through unchanged (default when contextAdjustment is omitted)
{ type: "none" }

// patch — shallow-merges a partial context into the current context
{ type: "patch", patch: { planningAttempts: 3 } }

// override — replaces the context entirely
// Note: traceId is always preserved even if omitted from the override ctx
{ type: "override", ctx: newCtx }
```

The `patch` mode is a shallow merge: top-level fields in `patch` overwrite the corresponding fields in `ctx`. Nested objects are replaced, not merged recursively.

---

## Context

```typescript
import { BaseContext } from "guidlio-lm";

interface PlanningContext extends BaseContext {
	goal: string;
	plan?: string[];
	planningAttempts: number;
	validationErrors?: string[];
	finalOutput?: string;
}
```

---

## Steps

```typescript
import {
	PipelineStep,
	StepResult,
	StepRunMeta,
	ok,
	failed,
	redirect,
} from "guidlio-lm";

class PlanStep extends PipelineStep<PlanningContext> {
	readonly name = "plan";

	async run(ctx: PlanningContext, _meta: StepRunMeta): Promise<StepResult<PlanningContext>> {
		const plan = await planner.generate(ctx.goal);
		// The step populates ctx.plan but does not increment planningAttempts itself —
		// that counter is the policy's concern (it tracks routing decisions, not step logic)
		return ok({ ctx: { ...ctx, plan } });
	}
}

class ValidatePlanStep extends PipelineStep<PlanningContext> {
	readonly name = "validate-plan";

	async run(ctx: PlanningContext, _meta: StepRunMeta): Promise<StepResult<PlanningContext>> {
		const errors = await validator.check(ctx.plan ?? []);
		if (errors.length > 0) {
			// Signal that validation found problems — the policy decides whether to retry
			return redirect({ ctx: { ...ctx, validationErrors: errors }, message: "invalid" });
		}
		return ok({ ctx: { ...ctx, validationErrors: [] } });
	}
}

class ExecuteStep extends PipelineStep<PlanningContext> {
	readonly name = "execute";

	async run(ctx: PlanningContext, _meta: StepRunMeta): Promise<StepResult<PlanningContext>> {
		const output = await executor.run(ctx.plan ?? []);
		return ok({ ctx: { ...ctx, finalOutput: output } });
	}
}
```

---

## Policy using contextAdjustment

```typescript
import {
	DefaultPolicy,
	PolicyDecisionInput,
	PolicyDecisionOutput,
	ContextAdjustment,
} from "guidlio-lm";

class PlanningPolicy extends DefaultPolicy<PlanningContext> {
	private readonly maxPlanningAttempts = 3;

	override async decide(
		input: PolicyDecisionInput<PlanningContext>,
	): Promise<PolicyDecisionOutput<PlanningContext>> {
		const { stepName, stepResult } = input;
		const { outcome, ctx } = stepResult;

		// When validate-plan signals "invalid", decide whether to re-plan or fail
		if (stepName === "validate-plan" && outcome.type === "redirect" && outcome.message === "invalid") {
			const attempts = ctx.planningAttempts + 1;

			if (attempts >= this.maxPlanningAttempts) {
				return {
					transition: {
						type: "fail",
						error: new Error(
							`Plan validation failed after ${attempts} attempts: ${(ctx.validationErrors ?? []).join("; ")}`,
						),
					},
				};
			}

			// Go back to plan, and use patch to increment the counter in the same decision
			// This keeps the counter update co-located with the routing decision that caused it
			const adjustment: ContextAdjustment<PlanningContext> = {
				type: "patch",
				patch: { planningAttempts: attempts },
			};

			return {
				transition: { type: "goto", stepName: "plan" },
				contextAdjustment: adjustment,
			};
		}

		// All other outcomes use the default logic (ok→next, failed→fail)
		return super.decide(input);
	}
}
```

---

## Wiring

```typescript
import { GuidlioOrchestrator } from "guidlio-lm";

const orchestrator = new GuidlioOrchestrator<PlanningContext>({
	steps: [new PlanStep(), new ValidatePlanStep(), new ExecuteStep()],
	policy: () => new PlanningPolicy(),
	// Each plan+validate cycle counts as 2 transitions; 3 attempts = up to 9 transitions
	maxTransitions: 20,
});

const result = await orchestrator.run({
	traceId: "plan-run-001",
	goal: "Write a marketing email for product launch",
	planningAttempts: 0,
});

if (result.status === "ok") {
	console.log("Final output:", result.ctx.finalOutput);
	console.log("Planning attempts used:", result.ctx.planningAttempts);
} else {
	console.error("Planning failed:", result.error.message);
}
```

---

## When to use `override`

Use `override` when the step computed a completely new context shape and the policy wants to install it wholesale. The orchestrator always preserves `traceId` even if the override context omits it.

```typescript
class ContextResetPolicy extends DefaultPolicy<PlanningContext> {
	override async decide(
		input: PolicyDecisionInput<PlanningContext>,
	): Promise<PolicyDecisionOutput<PlanningContext>> {
		const { stepResult } = input;

		// The step returned a fully-formed new context via the outcome
		if (stepResult.outcome.type === "ok" && stepResult.ctx.plan?.length === 0) {
			// Start over with a clean context but preserve the original goal
			const freshCtx: PlanningContext = {
				traceId: stepResult.ctx.traceId, // always included in override
				goal: stepResult.ctx.goal,
				planningAttempts: 0,
			};
			return {
				transition: { type: "goto", stepName: "plan" },
				contextAdjustment: { type: "override", ctx: freshCtx },
			};
		}

		return super.decide(input);
	}
}
```

---

## Why not mutate context inside the step?

Steps can of course put data into the context they return — that is normal and expected. The distinction is about **routing-related** state: counters that exist solely to control policy decisions (like `planningAttempts`) should be updated by the policy, not the step. This keeps the step's `run()` method focused on its actual work and makes policy tests straightforward to write without involving step logic.

---

## What to change next

- [fsm-routing.md](./fsm-routing.md) — `redirect` outcomes and `RedirectRoutingPolicy` for simpler message-based routing without subclassing
- [agent-plan-execute-verify.md](./agent-plan-execute-verify.md) — a full plan/execute/verify loop that uses context adjustments to track iteration state
