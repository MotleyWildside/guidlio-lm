# guidlio-lm Examples

A curated example library organized by what you're trying to do. Every example is a self-contained `.md` file with copy-paste-ready TypeScript.

Examples live in three trees:
- [`src/llm-service/examples/`](../src/llm-service/examples/) — single-call surface (text, JSON, streaming, embeddings, caching)
- [`src/orchestrator/examples/`](../src/orchestrator/examples/) — multi-step pipelines, FSM routing, agents
- [`examples/`](.) — end-to-end recipes and framework integrations (this folder)

---

## I want to make my first LLM call

- [Basic text generation](../src/llm-service/examples/01-basic-text.md) — `callText`, traceId, model overrides
- [JSON extraction with Zod](../src/llm-service/examples/02-json-extraction.md) — `callJSON`, schema validation, error handling
- [Streaming responses](../src/llm-service/examples/03-streaming.md) — `callStream`, SSE, no-retry caveat

## I want to work with embeddings

- [Embeddings](../src/llm-service/examples/04-embeddings.md) — `embed`, `embedBatch`, cosine similarity, Gemini `taskType`
- [Batched embeddings for RAG ingestion](../src/llm-service/examples/13-batched-embeddings-rag.md) — chunk → `embedBatch` → store, batch size tradeoffs
- [RAG pipeline](./rag-pipeline.md) — full embed-query → retrieve → rerank → generate pipeline

## I want to register and version prompts

- [Prompt registry](../src/llm-service/examples/05-prompt-registry.md) — `PromptDefinition`, versioning, variable interpolation
- [Dynamic prompt selection](../src/llm-service/examples/12-dynamic-prompt-selection.md) — `"latest"` vs pinned, A/B testing, hot-swap
- [Loading prompts from files or services](../src/llm-service/examples/extensions/prompt-registry-loading.md) — JSON files, async fetch, hot-reload

## I want to cache responses

- [Caching](../src/llm-service/examples/06-caching.md) — `read_through`, `refresh`, `bypass`, TTL, `InMemoryCacheProvider`
- [Idempotency and cache keys](../src/llm-service/examples/09-idempotency-and-cache-keys.md) — key derivation, `idempotencyKey`, `temperature: 0`
- [Caching strategies by category](./caching-strategies.md) — classification vs extraction vs chat, when not to cache
- [Redis-backed cache](../src/llm-service/examples/extensions/custom-cache-redis.md) — `ioredis`, TTL, namespacing, failure degradation

## I want to handle providers, retries, and errors

- [Providers and error handling](../src/llm-service/examples/07-providers-and-errors.md) — multi-provider, `defaultProvider`, `strictProviderSelection`, error taxonomy
- [Retry tuning](../src/llm-service/examples/11-retry-tuning.md) — `maxAttempts`, backoff formula, when to disable retries
- [Cancellation and timeouts](../src/llm-service/examples/08-cancellation-and-timeouts.md) — `AbortController`, deadline signals, `Promise.all` sharing a signal
- [Multi-provider fallback](./multi-provider-fallback.md) — orchestrator-level cross-provider fallback

## I want to observe, log, and measure cost

- [Observability and cost](../src/llm-service/examples/10-observability-and-cost.md) — logger wiring, log entry shape, token aggregation, OpenTelemetry adapter
- [Cost guardrails](./cost-guardrails.md) — budget policy that aborts a run when token spend exceeds a limit
- [Pipeline observer metrics](../src/orchestrator/examples/observer-metrics.md) — Prometheus-style counters/histograms per step
- [OpenTelemetry tracing observer](../src/orchestrator/examples/extensions/custom-observer-tracing.md) — spans per step, correlation with LLM traceId

## I want to add a custom provider

- [Custom provider — Anthropic](../src/llm-service/examples/extensions/custom-provider-anthropic.md) — full `LLMProvider` implementation with `@anthropic-ai/sdk`
- [Custom provider — llama.cpp](../src/llm-service/examples/extensions/custom-provider-local-llamacpp.md) — local HTTP endpoint, streaming normalization
- [Mock provider for testing](../src/llm-service/examples/extensions/custom-provider-mock-testing.md) — scripted responses, call recording, error injection

## I want to build a pipeline

- [Basic pipeline](../src/orchestrator/examples/basic.md) — three-step linear pipeline, default policy, error propagation
- [FSM routing with GOTO](../src/orchestrator/examples/fsm-routing.md) — `redirect` outcome, `RedirectRoutingPolicy`, observer
- [Retry with backoff](../src/orchestrator/examples/retry-with-backoff.md) — `RetryPolicy`, `meta.attempt`, `stepTimeoutMs`, factory pattern

## I want to build an agent

- [ReAct agent loop](../src/orchestrator/examples/agent-react-loop.md) — Reason → Act → Observe, `maxTransitions` guard
- [Plan → Execute → Verify agent](../src/orchestrator/examples/agent-plan-execute-verify.md) — self-correcting loop, `degrade` on exhaustion, `contextAdjustment`
- [Tool-using agent](./agent-with-tools.md) — SelectTool → RunTool → Observe loop, `RedirectRoutingPolicy`
- [RAG pipeline](./rag-pipeline.md) — retrieval-augmented generation as a pipeline

## I want to handle complex routing

- [FSM routing](../src/orchestrator/examples/fsm-routing.md) — `redirect` + `RedirectRoutingPolicy`
- [Conditional routing from context values](../src/orchestrator/examples/extensions/custom-policy-conditional-routing.md) — policy inspects `ctx.score` to choose step
- [Composing policies](../src/orchestrator/examples/extensions/custom-policy-composing.md) — `RetryPolicy` + fallback step via `super.fail()`

## I want to write production-grade policies

- [Circuit breaker](../src/orchestrator/examples/extensions/custom-policy-circuit-breaker.md) — open/close/cooldown across runs
- [Async feature flag policy](../src/orchestrator/examples/extensions/custom-policy-async-feature-flag.md) — async `decide()` with remote flag lookup
- [Concurrent runs and factory pattern](../src/orchestrator/examples/concurrent-runs-policy-factory.md) — why stateful policies must use a factory

## I want to write custom steps

- [LLM call step](../src/orchestrator/examples/extensions/custom-step-llm-call.md) — translating LLM errors into outcomes
- [HTTP call step](../src/orchestrator/examples/extensions/custom-step-http-call.md) — `fetch` with error classification
- [Parallel fan-out step](../src/orchestrator/examples/extensions/custom-step-parallel-fanout.md) — `Promise.all` with shared `AbortSignal`

## I want to test my code

- [Testing consumers](./testing-consumers.md) — `MockLLMProvider`, scripted responses, retry and cache behavior tests
- [Mock provider](../src/llm-service/examples/extensions/custom-provider-mock-testing.md) — full `MockLLMProvider` with error injection and call recording

## I want to deploy to production

- [Express](./integrations/express.md) — singleton service, per-request traceId, client-disconnect abort
- [Fastify](./integrations/fastify.md) — Fastify plugin, `pino` logger adapter, `request.id` as traceId
- [Next.js App Router](./integrations/nextjs-route-handler.md) — streaming `ReadableStream`, singleton, `request.signal`
- [AWS Lambda](./integrations/aws-lambda.md) — warm-start reuse, Redis cache, deadline-derived `AbortSignal`
- [Cloudflare Workers](./integrations/cloudflare-workers.md) — `nodejs_compat`, KV-backed cache, isolate lifecycle
- [BullMQ worker](./integrations/bullmq-worker.md) — job lifecycle, progress observer, cancellation

## I want to handle structured extraction failures

- [JSON extraction](../src/llm-service/examples/02-json-extraction.md) — `LLMParseError` vs `LLMSchemaError`, JSON repair
- [Structured extraction with orchestrator retry](./structured-extraction-with-retry.md) — repair prompt on schema error, orchestrator-level retry

## I want to run a batch job

- [Idempotent batch job](./batch-job-idempotent.md) — `idempotencyKey` per item, Redis-backed cache, restart-safe
