# Providers, Retries & Error Handling

## Setting up multiple providers

Register providers once; the service selects one per-call based on model-name prefix.

```typescript
import {
	LLMService,
	OpenAIProvider,
	GeminiProvider,
	OpenRouterProvider,
} from "guidlio-lm";

const llm = new LLMService({
	providers: [
		new OpenAIProvider(process.env.OPENAI_API_KEY!),
		new GeminiProvider(process.env.GEMINI_API_KEY!),
		new OpenRouterProvider(process.env.OPENROUTER_API_KEY!),
	],
});

// Routes to OpenAI (prefix "gpt-")
await llm.callText({ promptId: "p", model: "gpt-4o-mini", variables: {} });

// Routes to Gemini (prefix "gemini-")
await llm.callText({ promptId: "p", model: "gemini-2.0-flash", variables: {} });

// Routes to OpenRouter (prefix "anthropic/")
await llm.callText({ promptId: "p", model: "anthropic/claude-3-5-sonnet", variables: {} });
```

## Forcing a specific provider

`defaultProvider` bypasses model-prefix matching entirely — every call goes to the named provider.

```typescript
const llm = new LLMService({
	providers: [
		new OpenAIProvider(process.env.OPENAI_API_KEY!),
		new GeminiProvider(process.env.GEMINI_API_KEY!),
	],
	defaultProvider: "gemini",  // provider.name must match exactly
});
```

## Strict provider selection

By default, if no provider's `supportsModel` matches, the service falls back to the first registered provider and logs a warning. Enable `strictProviderSelection` to throw instead — recommended in production to surface misconfigurations early.

```typescript
const llm = new LLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	strictProviderSelection: true,
});

// Throws: "No registered provider supports model "gemini-2.0-flash""
await llm.callText({ promptId: "p", model: "gemini-2.0-flash", variables: {} });
```

## Retry configuration

Only `LLMTransientError` (429s, 5xx, timeouts) is retried. All other errors propagate immediately.

```typescript
const llm = new LLMService({
	providers: [...],
	maxAttempts: 5,            // 1 original + 4 retries (default: 3)
	retryBaseDelayMs: 500,     // base for exponential backoff (default: 1000 ms)
	maxDelayMs: 20_000,        // cap per-retry delay incl. jitter (default: 30 000 ms)
	promptRegistry: registry,
});
```

Delay for attempt `n` (0-indexed): `min(baseDelay × 2^n + rand(0, 1000), maxDelayMs)`.

## Error types

All errors extend `LLMError` and carry `provider`, `model`, `promptId?`, `requestId?`, and `cause`.

```typescript
import {
	LLMTransientError,
	LLMPermanentError,
	LLMParseError,
	LLMSchemaError,
} from "guidlio-lm";

try {
	const result = await llm.callJSON({ promptId: "sentiment", variables: { text } });
} catch (err) {
	if (err instanceof LLMTransientError) {
		// Retries exhausted — 429 or repeated 5xx
		console.error("Transient failure after all retries", err.statusCode);
	} else if (err instanceof LLMPermanentError) {
		// 4xx auth / quota / invalid request — do not retry
		console.error("Permanent failure", err.statusCode, err.message);
	} else if (err instanceof LLMParseError) {
		// Model returned prose that couldn't be repaired into JSON
		console.error("Parse failed. Raw output:", err.rawOutput.slice(0, 200));
	} else if (err instanceof LLMSchemaError) {
		// Parsed but Zod validation failed
		console.error("Schema mismatch:", err.validationErrors);
	} else {
		throw err; // unexpected — re-throw
	}
}
```

## Cancellation with AbortSignal

Pass a signal to any call method. When aborted, the provider SDK throws an `AbortError`-like error. The retry loop does **not** retry on abort.

```typescript
const controller = new AbortController();

// Cancel all pending LLM calls when the parent request is cancelled
req.on("close", () => controller.abort());

const result = await llm.callText({
	promptId: "summarize",
	variables: { text },
	signal: controller.signal,
});
```

For parallel calls, share the same controller:

```typescript
const [summary, tags] = await Promise.all([
	llm.callText({ promptId: "summarize", variables: { text }, signal: controller.signal }),
	llm.callJSON({ promptId: "tag",       variables: { text }, signal: controller.signal }),
]);
```

## Logging

Inject any `LLMLogger`-compatible logger. Every call emits a structured `llmCall` entry with fields useful for cost accounting and latency tracking.

```typescript
import { ConsoleLogger } from "guidlio-lm";

const llm = new LLMService({
	providers: [...],
	logger: new ConsoleLogger(),
	promptRegistry: registry,
});

// Each call logs something like:
// {
//   traceId: "trace_…",
//   promptId: "summarize",
//   promptVersion: 1,
//   model: "gpt-4o-mini",
//   provider: "openai",
//   success: true,
//   cached: false,
//   durationMs: 412,
//   usage: { promptTokens: 83, completionTokens: 42, totalTokens: 125 }
// }
```

Failed retries emit additional entries with `retry: true` and `success: false` — these are mid-flight events, not call outcomes. The terminal outcome (success or final failure) always has `retry` omitted.
