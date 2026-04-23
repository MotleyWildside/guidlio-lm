# Example: Conditional Routing Based on Context Values

Sometimes the right next step depends not on whether a step succeeded or failed,
but on a value it computed — a confidence score, a classification label, a risk
level. This example shows how to extend `DefaultPolicy` to inspect `stepResult.ctx`
inside `ok()` and return a `goto` transition instead of `next`, routing the pipeline
to different branches based on a numeric score. The step itself stays free of routing
logic: it updates ctx and returns `ok()`; the policy owns control flow.

**Concepts covered:**
- `ok()` override that reads a typed context field to choose a `goto` target
- Falling through to `super.ok()` for all other steps
- Keeping routing logic in the policy, not the step
- Typed context interface with a score field
- Branching pipeline topology: one entry point, two processing branches, one merge

---

## Context

```typescript
import { BaseContext } from "guidlio-lm";

interface ReviewContext extends BaseContext {
	documentId: string;
	text: string;
	score?: number;         // set by ClassifyStep; range [0, 1]
	reviewNotes?: string;   // set by HumanReviewStep
	approved?: boolean;     // set by the terminal branch step
}
```

---

## Policy

The `classify` step writes `ctx.score`. The policy reads it in `ok()` and routes
to either `"human-review"` (low confidence) or `"auto-approve"` (high confidence).
Every other step falls through to `super.ok()` which returns `{ type: "next" }`.

```typescript
import {
	DefaultPolicy,
	PolicyDecisionInput,
	BaseContext,
	StepOutcome,
	Transition,
} from "guidlio-lm";

type StepOutcomeOk = Extract<StepOutcome, { type: "ok" }>;

class ScoreRoutingPolicy extends DefaultPolicy<ReviewContext> {
	protected override ok(
		outcome: StepOutcomeOk,
		input: PolicyDecisionInput<ReviewContext>,
	): Transition {
		if (input.stepName === "classify") {
			const score = input.stepResult.ctx.score ?? 0;
			// score < 0.5 → low confidence; send to human review
			const stepName = score < 0.5 ? "human-review" : "auto-approve";
			return { type: "goto", stepName };
		}

		// All other steps: advance linearly
		return super.ok(outcome, input);
	}
}
```

`DefaultPolicy.ok()` returns `{ type: "next" }`. Calling `super.ok()` for the
non-classify case avoids reimplementing that default.

---

## Steps

```typescript
import { PipelineStep, StepResult, StepRunMeta, ok, failed } from "guidlio-lm";

class ClassifyStep extends PipelineStep<ReviewContext> {
	readonly name = "classify";

	async run(ctx: ReviewContext, meta: StepRunMeta): Promise<StepResult<ReviewContext>> {
		// The step only computes the score and writes it to ctx.
		// It does not know about "human-review" or "auto-approve".
		const score = await classifier.score(ctx.text, { signal: meta.signal });
		return ok({ ctx: { ...ctx, score } });
	}
}

class HumanReviewStep extends PipelineStep<ReviewContext> {
	readonly name = "human-review";

	async run(ctx: ReviewContext, _meta: StepRunMeta): Promise<StepResult<ReviewContext>> {
		const notes = await reviewQueue.submit(ctx.documentId, ctx.text);
		return ok({ ctx: { ...ctx, reviewNotes: notes, approved: true } });
	}
}

class AutoApproveStep extends PipelineStep<ReviewContext> {
	readonly name = "auto-approve";

	async run(ctx: ReviewContext, _meta: StepRunMeta): Promise<StepResult<ReviewContext>> {
		return ok({ ctx: { ...ctx, approved: true } });
	}
}

class FinalizeStep extends PipelineStep<ReviewContext> {
	readonly name = "finalize";

	async run(ctx: ReviewContext, _meta: StepRunMeta): Promise<StepResult<ReviewContext>> {
		await auditLog.record(ctx.documentId, ctx.approved, ctx.score);
		return ok({ ctx });
	}
}
```

---

## Wiring

All steps must be registered even though only one branch executes per run.
`GOTO` validates the target name at transition time and throws
`PipelineDefinitionError` if the step is missing.

```typescript
import { GuidlioOrchestrator } from "guidlio-lm";

const orchestrator = new GuidlioOrchestrator<ReviewContext>({
	steps: [
		new ClassifyStep(),
		new HumanReviewStep(),  // reached only when score < 0.5
		new AutoApproveStep(),  // reached only when score >= 0.5
		new FinalizeStep(),
	],
	// ScoreRoutingPolicy is stateless — a single instance is safe for all runs
	policy: new ScoreRoutingPolicy(),
});
```

Pipeline shape at runtime:

```
classify ──goto:human-review──► human-review ──next──► finalize
         └──goto:auto-approve──► auto-approve ──next──► finalize
```

---

## Running

```typescript
const highConf = await orchestrator.run({
	traceId: "doc-001",
	documentId: "doc-A",
	text: "Quarterly earnings report — clean financials.",
});
// highConf.ctx.score  === 0.92
// highConf.ctx.approved === true
// took: classify → auto-approve → finalize

const lowConf = await orchestrator.run({
	traceId: "doc-002",
	documentId: "doc-B",
	text: "Ambiguous marketing copy with unusual claims.",
});
// lowConf.ctx.score  === 0.31
// lowConf.ctx.approved === true (or false, depending on human reviewer)
// took: classify → human-review → finalize
```

---

## Extending the routing table

For more than two targets, add more conditions to the `ok()` override:

```typescript
protected override ok(outcome: StepOutcomeOk, input: PolicyDecisionInput<ReviewContext>): Transition {
	if (input.stepName === "classify") {
		const score = input.stepResult.ctx.score ?? 0;
		if (score < 0.3) return { type: "goto", stepName: "reject" };
		if (score < 0.7) return { type: "goto", stepName: "human-review" };
		return { type: "goto", stepName: "auto-approve" };
	}
	return super.ok(outcome, input);
}
```

For routing tables that live in a config store or depend on other context fields,
use an async `decide()` override instead — see `./custom-policy-async-feature-flag.md`.

---

## What to change next

- Route using `redirect` messages rather than score thresholds: `../fsm-routing.md`
- Add an async flag lookup to conditionally skip branches: `./custom-policy-async-feature-flag.md`
