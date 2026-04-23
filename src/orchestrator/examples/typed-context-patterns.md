# Typed Context Patterns

A pipeline's context object evolves as steps run — early steps produce data that later steps consume. TypeScript's type system can model this evolution precisely, but a few common traps turn it into a source of runtime errors. This example shows idioms that keep context types accurate and safe across a multi-step pipeline without resorting to `as` casts.

**Concepts covered:**
- Building up optional fields as steps populate them
- `requireField` assertion helper — safe narrowing without `as`
- Discriminated unions for stage-specific data that only exists in certain pipeline phases
- Why to avoid `as` casts on context fields
- A realistic four-step pipeline showing all patterns composed

---

## Baseline: optional fields added by each step

The simplest approach. Fields start as `undefined` and are narrowed in each step that needs them.

```typescript
import { BaseContext } from "guidlio-lm";

interface PipelineCtx extends BaseContext {
	rawInput: string;
	// Populated by step 2
	parsed?: { title: string; body: string };
	// Populated by step 3
	classification?: "urgent" | "routine" | "spam";
	// Populated by step 4
	response?: string;
}
```

A step that needs `parsed` must check it before use. A `requireField` helper makes that check safe and loud:

```typescript
function requireField<T, K extends keyof T>(ctx: T, field: K): NonNullable<T[K]> {
	const value = ctx[field];
	if (value === undefined || value === null) {
		throw new Error(
			`Pipeline context is missing required field "${String(field)}" — check that the step that populates it ran before this one`,
		);
	}
	return value as NonNullable<T[K]>;
}
```

Usage in a step:

```typescript
import { PipelineStep, StepResult, StepRunMeta, ok, failed } from "guidlio-lm";

class ClassifyStep extends PipelineStep<PipelineCtx> {
	readonly name = "classify";

	async run(ctx: PipelineCtx, _meta: StepRunMeta): Promise<StepResult<PipelineCtx>> {
		// Safe narrowing — throws with a clear message if ParseStep didn't run
		const parsed = requireField(ctx, "parsed");

		const classification = await classifier.classify(parsed.body);
		return ok({ ctx: { ...ctx, classification } });
	}
}
```

This is better than `ctx.parsed!` (silently crashes with a confusing message) or `ctx.parsed as { title: string; body: string }` (silences the type system, same silent crash).

---

## Discriminated unions for stage-specific data

When later stages require fields that earlier stages don't have, a discriminated union makes the constraint explicit at the type level.

```typescript
import { BaseContext } from "guidlio-lm";

type PipelineStage =
	| { stage: "input"; rawText: string }
	| { stage: "parsed"; rawText: string; parsed: { title: string; body: string } }
	| { stage: "classified"; rawText: string; parsed: { title: string; body: string }; classification: "urgent" | "routine" | "spam" }
	| { stage: "done"; rawText: string; parsed: { title: string; body: string }; classification: "urgent" | "routine" | "spam"; response: string };

type StageCtx = BaseContext & PipelineStage;
```

TypeScript narrows automatically on the `stage` discriminant, so accessing `.parsed` is only legal when `ctx.stage === "parsed"` (or later):

```typescript
class GenerateResponseStep extends PipelineStep<StageCtx> {
	readonly name = "generate";

	async run(ctx: StageCtx, _meta: StepRunMeta): Promise<StepResult<StageCtx>> {
		if (ctx.stage !== "classified") {
			// Shouldn't happen if the pipeline is wired correctly, but provides a clear error
			return { ctx, outcome: { type: "failed", error: new Error(`Expected stage 'classified', got '${ctx.stage}'`), retryable: false } };
		}

		// TypeScript knows ctx.classification exists here — no cast needed
		const response = await generateResponse(ctx.parsed.body, ctx.classification);

		const next: StageCtx = { ...ctx, stage: "done", response };
		return ok({ ctx: next });
	}
}
```

The tradeoff: discriminated unions require each step to transition `stage` explicitly and widen the union variant. They add boilerplate but eliminate entire classes of "accessed undefined field" bugs.

---

## Full four-step pipeline

Combining both patterns — a shared context with optional fields (simpler) plus a stage guard where the type contract is strict.

```typescript
import { BaseContext } from "guidlio-lm";

interface TicketCtx extends BaseContext {
	rawText: string;
	// set by ParseStep
	subject?: string;
	body?: string;
	// set by ClassifyStep
	urgency?: "p1" | "p2" | "p3";
	// set by DraftStep
	draft?: string;
}
```

```typescript
import { PipelineStep, StepResult, StepRunMeta, ok, failed, GuidlioOrchestrator } from "guidlio-lm";

class ParseStep extends PipelineStep<TicketCtx> {
	readonly name = "parse";

	async run(ctx: TicketCtx, _meta: StepRunMeta): Promise<StepResult<TicketCtx>> {
		const lines = ctx.rawText.split("\n");
		const subject = lines[0]?.trim();
		const body = lines.slice(1).join("\n").trim();

		if (!subject) {
			return failed({ ctx, error: new Error("Cannot parse empty ticket text"), retryable: false });
		}
		return ok({ ctx: { ...ctx, subject, body } });
	}
}

class ClassifyStep extends PipelineStep<TicketCtx> {
	readonly name = "classify";

	async run(ctx: TicketCtx, _meta: StepRunMeta): Promise<StepResult<TicketCtx>> {
		const subject = requireField(ctx, "subject");
		const body = requireField(ctx, "body");

		const urgency = await urgencyClassifier(subject, body);
		return ok({ ctx: { ...ctx, urgency } });
	}
}

class DraftStep extends PipelineStep<TicketCtx> {
	readonly name = "draft";

	async run(ctx: TicketCtx, _meta: StepRunMeta): Promise<StepResult<TicketCtx>> {
		const body = requireField(ctx, "body");
		const urgency = requireField(ctx, "urgency");

		const draft = await draftReply(body, urgency);
		return ok({ ctx: { ...ctx, draft } });
	}
}

class SendStep extends PipelineStep<TicketCtx> {
	readonly name = "send";

	async run(ctx: TicketCtx, _meta: StepRunMeta): Promise<StepResult<TicketCtx>> {
		const draft = requireField(ctx, "draft");
		await emailClient.send({ to: "support@example.com", body: draft });
		return ok({ ctx });
	}
}

const orchestrator = new GuidlioOrchestrator<TicketCtx>({
	steps: [new ParseStep(), new ClassifyStep(), new DraftStep(), new SendStep()],
});
```

---

## Why not `as` casts?

```typescript
// Don't do this:
const parsed = ctx.parsed as { title: string; body: string };
parsed.title.toUpperCase(); // silent crash if ctx.parsed is undefined

// Do this instead:
const parsed = requireField(ctx, "parsed");
parsed.title.toUpperCase(); // throws with "Pipeline context is missing required field 'parsed'"
```

`as` casts tell TypeScript "trust me" — they compile fine and crash at runtime with a confusing `Cannot read properties of undefined` message that doesn't name the pipeline step or the field. `requireField` throws at the exact point of access with a message that names the missing field, making bugs in pipeline wiring immediately obvious in logs.

---

## What to change next

- [basic.md](../basic.md) — simple linear pipeline without context evolution complexity
- [context-adjustments.md](../context-adjustments.md) — mutating context from the policy layer during transitions
