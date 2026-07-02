# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

`@motleywildside/ai-sdk` — a lightweight, provider-agnostic LLM gateway published as an NPM package. The package is pure TypeScript, ESM-native with dual CJS/ESM output via `tsup`. Node >=18.

## Commands

```bash
npm run build          # tsup → dual ESM+CJS bundle with .d.ts, cleans dist/
npm run dev            # tsup --watch
npm test               # vitest run (all tests)
npm run test:watch     # vitest (watch mode)
npm run test:coverage  # vitest run --coverage
npm run lint           # eslint src/**/*.ts
npm run format         # prettier --write "src/**/*.ts"
```

Tests live in `tests/` using Vitest. Fixtures are in `tests/fixtures/` — use `makeMockProvider`, `makeMockCache`, `makeMockLogger`, `makeMockObserver`, `makePrompt`/`makeJsonPrompt` for all test setup. Never import or instantiate `OpenAIProvider`/`GeminiProvider`/`OpenRouterProvider` in tests.

The only build entry is `src/index.ts`. Anything not re-exported from there is not part of the public API — be deliberate about what is added/removed.

Formatting: Prettier is configured with **tabs** (`"useTabs": true`), double quotes, trailing commas everywhere, 100-col print width. ESLint runs Prettier as a rule, so lint will fail on formatting drift.

## Architecture

The codebase has two independent subsystems that share only the logger and are composed by the consumer:

### 1. `src/llm-service/` — the LLM gateway

`LMService` is a thin orchestration layer over pluggable `LLMProvider` adapters (OpenAI, Gemini, OpenRouter). Key design choices:

#### Provider capabilities at a glance

| Provider | text | stream | embed | image |
|---|---|---|---|---|
| `OpenAIProvider` | ✓ | ✓ | ✓ | ✓ DALL-E 2/3 (`dall-e-*`) |
| `GeminiProvider` | ✓ | ✓ | ✓ | ✓ Imagen (`imagen-*`) + Gemini image (`gemini-*-image`) |
| `OpenRouterProvider` | ✓ | ✓ | — | ✓ (OpenRouter Images API) |

**DALL-E specifics** (`OpenAIProvider`):
- DALL-E 3: use `aspectRatio` to select size (`1:1` → 1024×1024, `16:9` → 1792×1024, `9:16` → 1024×1792); `3:4`/`4:3` throw `LLMPermanentError`. `numberOfImages` must be 1.
- DALL-E 2: use `imageSize` (`"0.5K"` → 512×512, `"1K"` → 1024×1024); `"2K"`/`"4K"` throw `LLMPermanentError`. Only `1:1` aspect ratio supported.
- Both models always return `image/png` base64 (`response_format: "b64_json"` — no URL fetch needed).
- Parameters with no DALL-E equivalent (`negativePrompt`, `seed`, `guidanceScale`, `enhancePrompt`, `personGeneration`) are silently ignored.
- DALL-E 3 surfaces the model's revised prompt in `LLMProviderImageResponse.text`.

**OpenRouter image specifics** (`OpenRouterProvider`):
- Uses OpenRouter's dedicated Images API through `@openrouter/sdk`.
- Supports `numberOfImages`, `aspectRatio`, `imageSize`, `outputMimeType`,
  `outputCompressionQuality`, `seed`, and base64 `inputImages`.
- `"0.5K"` is normalized to OpenRouter's `"512"` resolution.
- `numberOfImages` must be 1–10; `outputCompressionQuality` must be 0–100.

- **Provider selection** ([LMService.ts:65](src/llm-service/LMService.ts#L65)): if `config.defaultProvider` is set, it's used unconditionally (with a warning+fallback if the name doesn't resolve). Otherwise providers are probed via `supportsModel(model)`, falling back to the first registered provider. Providers match by model-name prefix (see `supportedModelPrefixes` in each provider).
- **Retry policy** ([LMService.ts:585](src/llm-service/LMService.ts#L585)): exponential backoff is applied **only** to `LLMTransientError`. Any other error — including `LLMPermanentError`, `LLMParseError`, `LLMSchemaError` — propagates immediately. Streaming (`callStream`) bypasses retries entirely; reconnection is the caller's responsibility.
- **JSON path** (`callJSON`): appends an explicit "return ONLY valid JSON" instruction to the last user message if one isn't already present, then parses. On parse failure it runs `repairJSON` (strips markdown fences, extracts the first `{...}` block) before throwing `LLMParseError`. Zod validation runs after parsing and throws `LLMSchemaError` on failure.
- **Cache key** ([LMService.ts:665](src/llm-service/LMService.ts#L665)): sha256 of `idempotencyKey | promptId | version | JSON(variables) | model | temperature`. `temperature` uses a nullish check so `0` is a distinct key, not "unset". Cache is only read on `mode: "read_through"` and written on `read_through` or `refresh` — and only when `ttlSeconds` is provided. `enableCache: false` disables both sides.
- **PromptRegistry** is in-memory only. `register` indexes by `promptId@version` and also tracks a "latest" per id via numeric-then-lexicographic comparison. `buildMessages` interpolates `{variableName}` placeholders; objects/arrays get `JSON.stringify`'d, missing vars are left as literal `{name}`.

Errors live in [src/llm-service/errors.ts](src/llm-service/errors.ts) — the transient/permanent distinction is load-bearing for retry behavior, so preserve it when adding new error paths.

### 2. `src/orchestrator/` — FSM pipeline framework

`PipelineOrchestrator` runs step-based pipelines with policy-driven transitions. The **central discipline** is the split between:

- **Step outcomes** (semantic: `ok` / `failed` / `redirect`) — what happened, decided by the step.
- **Transitions** (control flow: `next` / `goto` / `retry` / `stop` / `fail` / `degrade`) — where to go, decided by the policy.

Steps return outcomes, **not** transitions. A new step type should extend the `StepOutcome` union in [types.ts](src/orchestrator/types.ts), not invent new transitions. Conversely, policies map outcomes → transitions; custom retry/branching logic goes in a `DefaultPolicy` subclass (see [DefaultPolicy.ts](src/orchestrator/DefaultPolicy.ts)).

Other non-obvious behaviors:

- **Exception handling** ([PipelineOrchestrator.ts:305](src/orchestrator/PipelineOrchestrator.ts#L305)): thrown errors inside a step are caught and converted to `{ type: 'failed', retryable: true }` outcomes — they do not crash the pipeline. The policy then decides what to do.
- **`maxTransitions`** (default 50, [constants.ts](src/orchestrator/constants.ts)) is the only guard against infinite `goto`/`retry` loops. Policies with unbounded retry counters **must** implement `reset()` (called at the start of each run) or state leaks between runs.
- **`degrade` vs `stop`**: both terminate with `PIPELINE_STATUS.OK`, but `degrade` sets `result.degraded: true` on the run result — use it for graceful partial failures, not clean completions.
- **Context adjustments**: the policy can return a `contextAdjustment` alongside a transition (`patch` / `override` / `none`) to mutate context during a transition rather than inside a step.

### Public API boundary

All exports must go through [src/index.ts](src/index.ts). The module-level `llm-service/index.ts` and `orchestrator/index.ts` barrels are re-exported selectively — adding a symbol to an inner barrel does **not** make it public. Types are exported with `export type` to keep `isolatedModules`-compatible consumers happy.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `MotleyWildside/guidlio-lm`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default mattpocock/skills triage label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: read root `CONTEXT.md` and root `docs/adr/` when present. See `docs/agents/domain.md`.
