# LLM Service Module

The `LLMService` module is the core gateway for all Large Language Model interactions within the package. It provides a unified interface for text generation, JSON extraction, streaming, and embeddings, regardless of the underlying provider (OpenAI, Gemini, OpenRouter).

## Key Features

- **Provider Agnostic**: Unified API across OpenAI, Gemini, and OpenRouter. Auto-selects a provider by model-name prefix, or honors an explicit `defaultProvider`.
- **Robust JSON Extraction**: Built-in markdown-fence stripping, object/array repair, and Zod schema validation (via peer dependency).
- **Prompt Management**: Integration with `PromptRegistry` for versioned templates and `{variable}` interpolation.
- **Resilience**: Exponential backoff with jitter on `LLMTransientError`, capped by `maxDelayMs`. Permanent and parse/schema errors fail fast. Embeddings share the same retry pipeline.
- **Cancellation**: `AbortSignal` support on every call method, propagated to the underlying provider SDK.
- **Caching**: Read-through and refresh caching. Cache keys include the resolved model, response format, schema fingerprint, and all generation parameters so semantically-different calls never collide.
- **Observability**: Structured `llmCall` log entries carry `traceId`, `promptId`, token usage, duration, cached-flag, and retry-flag.

## Core API

### `LLMService`

| Method | Description |
| :--- | :--- |
| `callText(params)` | Returns a text response. Caches when `params.cache` is set. |
| `callJSON<T>(params)` | Returns a parsed+validated JSON object. Repairs malformed JSON on first pass; throws `LLMParseError` or `LLMSchemaError` if it still fails. |
| `callStream(params)` | Returns a text stream. Bypasses retries and caching; reconnection is the caller's responsibility. |
| `embed(params)` | Returns a single vector embedding (with retries). |
| `embedBatch(params)` | Returns vector embeddings for an array of texts (with retries). |

All methods accept `traceId?` and `signal?: AbortSignal`.

### `LLMServiceConfig`

| Field | Default | Notes |
| :--- | :--- | :--- |
| `providers` | **required** | Array of `LLMProvider` instances. |
| `defaultProvider` | auto-select | Name of a registered provider to use unconditionally. |
| `defaultModel` | — | Final fallback when neither call params nor prompt defaults specify a model. |
| `defaultTemperature` | `0.7` | Final fallback for temperature. |
| `maxAttempts` | `3` | Total attempts per call (1 = no retries). |
| `retryBaseDelayMs` | `1000` | Base for exponential backoff. |
| `maxDelayMs` | `30000` | Upper bound on a single retry delay (incl. jitter). |
| `strictProviderSelection` | `false` | When true, throws if no provider supports the requested model instead of falling back to the first registered provider. |
| `enableCache` | `true` | Set to `false` to disable caching globally. |
| `cacheProvider` | `InMemoryCacheProvider` | Swap for Redis, etc. |
| `promptRegistry` | new `PromptRegistry` | Inject a pre-populated registry. |
| `logger` | — | Any `LLMLogger`; omitted → silent. |

### `Prompt Registry`

The `PromptRegistry` manages versioned prompt templates with `{variable}` interpolation. You can register prompts using `llm.promptRegistry.register(definition)`.

#### `PromptDefinition` Fields

| Field | Type | Description |
| :--- | :--- | :--- |
| `promptId` | `string` | **Required**. Unique identifier for the prompt. |
| `version` | `string \| number` | **Required**. Version identifier. Numeric versions are compared numerically for "latest" resolution. |
| `systemPrompt` | `string` | Optional. The system message template. |
| `userPrompt` | `string` | Optional. The user message template. Supports `{variable}` placeholders. |
| `developer` | `string` | Optional. Alternate system role (mapped to `system` for most providers). |
| `modelDefaults` | `object` | **Required**. Default parameters for the model call. |
| `modelDefaults.model` | `string` | **Required**. The model name (e.g., `gpt-4o`). |
| `modelDefaults.temperature` | `number` | Optional. Sampling temperature (0 to 2). |
| `modelDefaults.maxTokens` | `number` | Optional. Maximum tokens to generate. |
| `modelDefaults.topP` | `number` | Optional. Nucleus sampling threshold. |
| `output` | `object` | **Required**. Configuration for the expected output. |
| `output.type` | `'text' \| 'json'` | **Required**. Whether to expect plain text or structured JSON. |
| `output.schema` | `z.ZodSchema` | Optional. Zod schema for validating JSON output. |


## Usage Example

```typescript
import { z } from "zod";
import { LLMService } from "./LLMService";
import { OpenAIProvider } from "./providers/OpenAIProvider";

const llm = new LLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	defaultProvider: "openai",
	maxAttempts: 4,
	maxDelayMs: 15_000,
});

llm.promptRegistry.register({
	promptId: "analyze-sentiment",
	version: 1,
	userPrompt: "Classify the sentiment of: {text}",
	modelDefaults: { model: "gpt-4o-mini" },
	output: { type: "json" },
});

// JSON with per-call schema + cancellation
const controller = new AbortController();
const result = await llm.callJSON({
	promptId: "analyze-sentiment",
	variables: { text: "I love this library!" },
	jsonSchema: z.object({ sentiment: z.string(), score: z.number() }),
	signal: controller.signal,
	cache: { mode: "read_through", ttlSeconds: 3600 },
});

console.log(result.data.sentiment); // "positive"
```

## Error Handling

All errors extend `LLMError` and carry `provider`, `model`, `promptId`, `requestId`, and `cause`.

| Class | When thrown | Retried? |
| :--- | :--- | :--- |
| `LLMTransientError` | 429, 5xx, timeouts | Yes (up to `maxAttempts`) |
| `LLMPermanentError` | 4xx auth/validation errors | No |
| `LLMParseError` | JSON parse + repair both failed | No |
| `LLMSchemaError` | Zod validation failed | No |

The transient/permanent split is load-bearing for retry behavior. Preserve it when adding new error paths.

## Internal Structure

```
llm-service/
├── LLMService.ts               Orchestration: public API + shared executors
├── errors.ts                   Error hierarchy
├── types.ts                    Public param/result/config types
├── cache/                      CacheProvider interface + in-memory impl
├── prompts-registry/           Versioned prompt storage + interpolation
├── providers/                  OpenAI / Gemini / OpenRouter adapters
└── internal/                   Private helpers (not re-exported)
    ├── logContext.ts           CallContext + logOutcome + errorMessage
    ├── retry.ts                callWithRetries + backoff defaults
    ├── cacheKey.ts             buildCacheKey + Zod schema fingerprint
    ├── providerSelection.ts    selectProvider (default → match → fallback)
    └── jsonHelpers.ts          parseAndRepairJSON, validateSchema, enforceJsonInstruction
```

`internal/` is implementation detail and is not exported from the package. Public API surface is defined by [`src/llm-service/index.ts`](./index.ts) and re-exported through [`src/index.ts`](../index.ts).

## Peer Dependencies

`zod` is a **peer dependency** so consumers share a single copy — `instanceof z.ZodError` works across the boundary and Zod schemas are interchangeable.
