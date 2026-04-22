# Basic Text Generation

## Minimal setup

```typescript
import { LLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";

const registry = new PromptRegistry();

registry.register({
	promptId: "summarize",
	version: 1,
	systemPrompt: "You are a concise summarizer. Reply in at most 3 sentences.",
	userPrompt: "Summarize this: {text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
	output: { type: "text" },
});

const llm = new LLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});

const result = await llm.callText({
	promptId: "summarize",
	variables: { text: "Large language models are neural networks trained on vast text corpora..." },
});

console.log(result.text);
// "LLMs are neural networks..."
console.log(result.durationMs, result.usage?.totalTokens);
```

## Overriding defaults per-call

Prompt defaults are the baseline — every call param wins over them.

```typescript
const result = await llm.callText({
	promptId: "summarize",
	variables: { text: longArticle },
	model: "gpt-4o",          // override modelDefaults.model
	temperature: 0.1,          // override modelDefaults.temperature
	maxTokens: 256,
	seed: 42,                  // deterministic output
});
```

## Propagating trace IDs

If you run LLMService inside a larger request pipeline, pass the existing trace ID so all log entries share the same correlation key.

```typescript
const result = await llm.callText({
	promptId: "summarize",
	variables: { text },
	traceId: req.headers["x-trace-id"] as string,
});
// result.traceId === the same value you passed in
```

## Using `defaultModel` as a global fallback

When neither call params nor the prompt definition specify a model, the service uses `config.defaultModel`.

```typescript
const llm = new LLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	defaultModel: "gpt-4o-mini",
	promptRegistry: registry,
});

registry.register({
	promptId: "greet",
	version: 1,
	userPrompt: "Say hello to {name}.",
	modelDefaults: { model: "" }, // intentionally empty — will use defaultModel
	output: { type: "text" },
});
```

## Structured result

`LLMTextResult` always includes:

```typescript
interface LLMTextResult {
	text: string;
	traceId: string;
	promptId: string;
	promptVersion: string | number;
	model: string;
	durationMs: number;
	usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
	finishReason?: string;
	requestId?: string;  // provider-side request ID for support tickets
}
```
