# Multi-Provider Fallback

When your primary LLM provider is degraded, you want to automatically retry on a different provider rather than returning an error to the user. `GuidlioLMService` handles transient retries within a single provider, but switching providers is a routing decision that belongs at the orchestrator layer. This recipe shows how to wire a primary OpenAI call with an automatic Gemini fallback using a custom `DefaultPolicy` subclass.

**Concepts covered:**
- Both providers registered on the same `GuidlioLMService` instance with per-step model selection
- `failed({ retryable: false })` from a step to prevent service-level retry and hand control to the orchestrator
- `DefaultPolicy` subclass that routes `failed` outcomes to a fallback step
- Why `defaultProvider` must not be set when using per-step model routing
- `failureReason` stored in context for logging and observability

---

## Context

```typescript
import { BaseContext } from "guidlio-lm";

interface FallbackContext extends BaseContext {
	promptId: string;
	variables: Record<string, string>;
	result?: string;
	failureReason?: string;
}
```

---

## Service setup

Both providers are registered on a single service. The service picks the provider by matching the model name prefix: `"gpt-*"` routes to OpenAI, `"gemini-*"` routes to Gemini. Do not set `defaultProvider` — that would bypass model-prefix matching and lock every call to one provider.

```typescript
import {
	GuidlioLMService,
	OpenAIProvider,
	GeminiProvider,
	PromptRegistry,
	ConsoleLogger,
} from "guidlio-lm";

const registry = new PromptRegistry();

registry.register({
	promptId: "summarize",
	version: 1,
	systemPrompt: "You are a concise summarizer. Respond in 2-3 sentences.",
	userPrompt: "Summarize: {text}",
	// No model default — each step specifies its own model
	modelDefaults: { model: "" },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [
		new OpenAIProvider(process.env.OPENAI_API_KEY!),
		new GeminiProvider(process.env.GEMINI_API_KEY!),
	],
	// No defaultProvider — auto-selection based on model prefix is what we want
	promptRegistry: registry,
	logger: new ConsoleLogger(),
	// Service-level retry handles transient errors on a single provider.
	// We keep maxAttempts low here because the orchestrator handles cross-provider fallback.
	maxAttempts: 2,
});
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
	LLMTransientError,
} from "guidlio-lm";

class PrimaryCallStep extends PipelineStep<FallbackContext> {
	readonly name = "primary-call";

	constructor(private readonly llmSvc: GuidlioLMService) {
		super();
	}

	async run(ctx: FallbackContext, meta: StepRunMeta): Promise<StepResult<FallbackContext>> {
		try {
			const result = await this.llmSvc.callText({
				promptId: ctx.promptId,
				variables: ctx.variables,
				// Explicitly route to OpenAI
				model: "gpt-4o",
				signal: meta.signal,
			});
			return ok({ ctx: { ...ctx, result: result.text } });
		} catch (err) {
			if (err instanceof LLMTransientError) {
				// Service-level retries are already exhausted at this point.
				// Return non-retryable failed so the orchestrator can route to fallback.
				return failed({
					ctx: { ...ctx, failureReason: err.message },
					error: err,
					// retryable: false tells the policy not to retry this step —
					// the policy will instead goto "fallback-call"
					retryable: false,
				});
			}
			// Permanent errors (auth, quota, bad request) are not recoverable by switching providers
			return failed({
				ctx: { ...ctx, failureReason: err instanceof Error ? err.message : String(err) },
				error: err instanceof Error ? err : new Error(String(err)),
				retryable: false,
				statusCode: 500,
			});
		}
	}
}

class FallbackCallStep extends PipelineStep<FallbackContext> {
	readonly name = "fallback-call";

	constructor(private readonly llmSvc: GuidlioLMService) {
		super();
	}

	async run(ctx: FallbackContext, meta: StepRunMeta): Promise<StepResult<FallbackContext>> {
		try {
			const result = await this.llmSvc.callText({
				promptId: ctx.promptId,
				variables: ctx.variables,
				// Explicitly route to Gemini
				model: "gemini-2.0-flash",
				signal: meta.signal,
			});
			return ok({ ctx: { ...ctx, result: result.text } });
		} catch (err) {
			return failed({
				ctx: { ...ctx, failureReason: err instanceof Error ? err.message : String(err) },
				error: err instanceof Error ? err : new Error(String(err)),
				retryable: false,
			});
		}
	}
}
```

---

## Policy

The policy overrides the `fail` handler so that a failure from `primary-call` redirects to `fallback-call`, while a failure from `fallback-call` gives up entirely.

```typescript
import {
	DefaultPolicy,
	PolicyDecisionInput,
	PolicyDecisionOutput,
	StepOutcomeFailed,
} from "guidlio-lm";

class FallbackPolicy extends DefaultPolicy<FallbackContext> {
	protected override fail(
		outcome: StepOutcomeFailed,
		input: PolicyDecisionInput<FallbackContext>,
	): PolicyDecisionOutput<FallbackContext> {
		if (input.stepName === "primary-call") {
			// Primary failed — try the fallback provider
			return { transition: { type: "goto", stepName: "fallback-call" } };
		}
		// Fallback also failed — give up
		return super.fail(outcome, input);
	}
}
```

---

## Wiring

```typescript
import { GuidlioOrchestrator } from "guidlio-lm";

const orchestrator = new GuidlioOrchestrator<FallbackContext>({
	steps: [new PrimaryCallStep(llm), new FallbackCallStep(llm)],
	policy: () => new FallbackPolicy(),
	maxTransitions: 10,
});
```

---

## Running

```typescript
const result = await orchestrator.run({
	traceId: crypto.randomUUID(),
	promptId: "summarize",
	variables: { text: "Large language models are transforming how developers build products..." },
});

if (result.status === "ok") {
	console.log("Summary:", result.ctx.result);
	if (result.ctx.failureReason) {
		// Primary failed, fallback succeeded — log for monitoring
		console.warn("Primary provider failed, used fallback. Reason:", result.ctx.failureReason);
	}
} else {
	console.error("Both providers failed:", result.error.message);
}
```

---

## Why this belongs at the orchestrator layer

`GuidlioLMService` retry is designed to handle transient failures on a single provider: the same request goes to the same provider with the same credentials up to `maxAttempts` times. Switching providers is a different concern — it may require different models, different API keys, and different response characteristics. The orchestrator's policy layer is the right place for that routing decision because it can inspect the outcome, check context, and make a dynamic goto.

---

## What to change next

- [Cost guardrails](cost-guardrails.md) — abort the pipeline when cumulative token spend exceeds a budget
- [Retry with exponential backoff](../src/orchestrator/examples/retry-with-backoff.md) — service-level retry tuning before the fallback fires
