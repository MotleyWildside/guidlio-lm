# Cost Guardrails

Long pipelines that make multiple LLM calls can unexpectedly exceed your token budget, especially when a retry loop or agent loop runs more iterations than expected. This recipe shows how to accumulate token counts across steps in context and use a custom `DefaultPolicy` subclass to abort the pipeline with a `429`-like error as soon as the budget is exceeded.

**Concepts covered:**
- Accumulating `result.usage.totalTokens` from each step into `ctx.tokensUsed`
- `BudgetPolicy` extending `DefaultPolicy` to check the budget after every `ok` outcome
- `BudgetExceededError` as a typed custom error for clean catch-site handling
- Returning `{ type: "fail", statusCode: 429 }` from a policy override
- Catching `result.error` and inspecting `result.error.cause` at the call site

---

## Context

```typescript
import { BaseContext } from "guidlio-lm";

interface GuardedContext extends BaseContext {
	query: string;
	tokensBudget: number;
	tokensUsed: number;
	classification?: string;
	summary?: string;
	result?: string;
}
```

---

## Custom error

```typescript
class BudgetExceededError extends Error {
	readonly tokensUsed: number;
	readonly tokensBudget: number;

	constructor(tokensUsed: number, tokensBudget: number) {
		super(`Token budget exceeded: used ${tokensUsed}, budget ${tokensBudget}`);
		this.name = "BudgetExceededError";
		this.tokensUsed = tokensUsed;
		this.tokensBudget = tokensBudget;
	}
}
```

---

## Service setup

```typescript
import {
	GuidlioLMService,
	OpenAIProvider,
	PromptRegistry,
} from "guidlio-lm";

const registry = new PromptRegistry();

registry.register({
	promptId: "classify",
	version: 1,
	systemPrompt: "You classify queries into categories: technical, billing, general.",
	userPrompt: "Classify this query: {query}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0 },
	output: { type: "text" },
});

registry.register({
	promptId: "summarize",
	version: 1,
	systemPrompt: "You summarize queries in one sentence.",
	userPrompt: "Summarize: {query}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0 },
	output: { type: "text" },
});

registry.register({
	promptId: "respond",
	version: 1,
	systemPrompt: "You are a helpful assistant. Respond to the user's query.",
	userPrompt: "Query category: {classification}\nSummary: {summary}\nOriginal: {query}",
	modelDefaults: { model: "gpt-4o", temperature: 0.5 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});
```

---

## Steps

Each step increments `ctx.tokensUsed` after every LLM call. The policy checks the running total after each `ok` outcome.

```typescript
import {
	PipelineStep,
	StepResult,
	StepRunMeta,
	ok,
	failed,
} from "guidlio-lm";

class ClassifyStep extends PipelineStep<GuardedContext> {
	readonly name = "classify";

	constructor(private readonly llmSvc: GuidlioLMService) {
		super();
	}

	async run(ctx: GuardedContext, meta: StepRunMeta): Promise<StepResult<GuardedContext>> {
		const result = await this.llmSvc.callText({
			promptId: "classify",
			variables: { query: ctx.query },
			signal: meta.signal,
		});
		const tokensUsed = ctx.tokensUsed + (result.usage?.totalTokens ?? 0);
		return ok({ ctx: { ...ctx, classification: result.text.trim(), tokensUsed } });
	}
}

class SummarizeStep extends PipelineStep<GuardedContext> {
	readonly name = "summarize";

	constructor(private readonly llmSvc: GuidlioLMService) {
		super();
	}

	async run(ctx: GuardedContext, meta: StepRunMeta): Promise<StepResult<GuardedContext>> {
		const result = await this.llmSvc.callText({
			promptId: "summarize",
			variables: { query: ctx.query },
			signal: meta.signal,
		});
		const tokensUsed = ctx.tokensUsed + (result.usage?.totalTokens ?? 0);
		return ok({ ctx: { ...ctx, summary: result.text.trim(), tokensUsed } });
	}
}

class RespondStep extends PipelineStep<GuardedContext> {
	readonly name = "respond";

	constructor(private readonly llmSvc: GuidlioLMService) {
		super();
	}

	async run(ctx: GuardedContext, meta: StepRunMeta): Promise<StepResult<GuardedContext>> {
		const result = await this.llmSvc.callText({
			promptId: "respond",
			variables: {
				classification: ctx.classification ?? "unknown",
				summary: ctx.summary ?? ctx.query,
				query: ctx.query,
			},
			signal: meta.signal,
		});
		const tokensUsed = ctx.tokensUsed + (result.usage?.totalTokens ?? 0);
		return ok({ ctx: { ...ctx, result: result.text, tokensUsed } });
	}
}
```

---

## Budget policy

```typescript
import {
	DefaultPolicy,
	PolicyDecisionInput,
	PolicyDecisionOutput,
	StepOutcomeOk,
} from "guidlio-lm";

class BudgetPolicy extends DefaultPolicy<GuardedContext> {
	override ok(
		outcome: StepOutcomeOk<GuardedContext>,
		input: PolicyDecisionInput<GuardedContext>,
	): PolicyDecisionOutput<GuardedContext> {
		const { tokensUsed, tokensBudget } = outcome.ctx;

		if (tokensUsed > tokensBudget) {
			return {
				transition: {
					type: "fail",
					error: new BudgetExceededError(tokensUsed, tokensBudget),
					statusCode: 429,
				},
			};
		}

		return super.ok(outcome, input);
	}
}
```

---

## Wiring

```typescript
import { GuidlioOrchestrator } from "guidlio-lm";

const orchestrator = new GuidlioOrchestrator<GuardedContext>({
	steps: [new ClassifyStep(llm), new SummarizeStep(llm), new RespondStep(llm)],
	policy: () => new BudgetPolicy(),
	maxTransitions: 20,
});
```

---

## Running and handling budget errors

```typescript
import { StepExecutionError } from "guidlio-lm";

const result = await orchestrator.run({
	traceId: crypto.randomUUID(),
	query: "My invoice shows a charge I don't recognise. Can you explain it?",
	tokensBudget: 500, // abort if the pipeline uses more than 500 tokens in total
	tokensUsed: 0,
});

if (result.status === "ok") {
	console.log("Response:", result.ctx.result);
	console.log("Tokens used:", result.ctx.tokensUsed, "/", result.ctx.tokensBudget);
} else {
	// StepExecutionError wraps the error returned by the policy's fail transition
	if (result.error.cause instanceof BudgetExceededError) {
		console.warn("Budget exceeded:", result.error.cause.message);
		console.warn("Tokens used:", result.error.cause.tokensUsed);
		// result.error.statusCode === 429
	} else {
		console.error("Pipeline failed:", result.error.message);
	}
}
```

---

## Tuning the budget

Budget values depend on the models and prompts involved. As a rough calibration baseline with `gpt-4o-mini`:

- A short classification call (< 20 words): ~50-100 tokens
- A summarization call: ~100-200 tokens
- A response call (moderate length): ~300-800 tokens

For pipelines with a retry loop or agent loop, multiply the per-step budget by the maximum expected iterations and add a 20% buffer.

---

## What to change next

- [Cost observability](../src/llm-service/examples/10-observability-and-cost.md) — log token usage per call for monitoring dashboards
- [Agent with tools](agent-with-tools.md) — apply budget guardrails to a looping agent
