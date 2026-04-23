# 🧠 guidlio-lm

> A modern, simple, type-safe, and provider-agnostic gateway for LLMs.

Stop fighting with multiple SDKs. **guidlio-lm** provides a unified interface for OpenAI, Gemini, OpenRouter and any custom providers with built-in prompt management, caching, and complex workflow orchestration.

---

## ✨ Features

- **Unified API**: One interface for OpenAI, Anthropic (via OpenRouter), and Gemini.
- **Smart Caching**: Built-in `read_through` and `refresh` modes to save costs and latency.
- **Type-Safe Schema**: Native Zod integration for guaranteed structured outputs.
- **Prompt Registry**: Decouple prompts from code with versioning and variables.
- **Pipeline Orchestrator**: Build complex, stateful AI workflows with ease.

## 🚀 Quick Start

### 1. Install

```bash
npm install guidlio-lm
```

### 2. Initialize

```typescript
import { GuidlioLMService, OpenAIProvider } from "guidlio-lm";

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY)],
	enableCache: true,
});
```

### 3. Register Prompts

Decouple your prompts from code using the built-in registry. Supports variables, versioning, and model defaults.

```typescript
llm.promptRegistry.register({
	promptId: "hello_world",
	version: 1,
	system: "You are a helpful assistant.",
	userTemplate: "Hello, {name}! How are you today?",
	modelDefaults: {
		model: "gpt-4o",
		temperature: 0.7,
	},
});

llm.promptRegistry.register({
	promptId: "get_city_info",
	version: 1,
	system: "You are a travel expert.",
	userTemplate: "Provide details about {city}.",
	output: { type: "json" }, // Enforces JSON mode
	modelDefaults: { model: "gemini-1.5-flash" },
});
```

### 4. Basic Call

```typescript
const result = await llm.callText({
	promptId: "hello_world",
	variables: { name: "User" },
});

console.log(result.text);
```

### 5. Structured JSON (with Zod)

```typescript
const result = await llm.callJSON({
	promptId: "get_city_info",
	variables: { city: "Paris" },
	jsonSchema: z.object({
		population: z.number(),
		landmark: z.string(),
	}),
});

console.log(result.data.landmark); // Fully typed
```

## ⛓️ Pipelines

Build complex multi-step workflows with the `GuidlioOrchestrator`:

```typescript
import { GuidlioOrchestrator, ok } from "guidlio-lm";

const pipe = new GuidlioOrchestrator({
	steps: [
		{
			name: "classify",
			run: async (ctx) => ok({ ctx: { ...ctx, category: "support" } }),
		},
		{
			name: "respond",
			run: async (ctx) => ok({ ctx: { ...ctx, reply: "How can I help?" } }),
		},
	],
});

const { status, ctx } = await pipe.run({ input: "..." });
```

## 🛠️ Configuration

Full control over retries, logging, and custom providers:

```typescript
const llm = new GuidlioLMService({
  providers: [...],
  maxRetries: 3,
  logger: new MyCustomLogger(),
  cacheProvider: new RedisCacheProvider() // Easy to extend
});
```

## 💾 Caching

Optimize your costs and performance with flexible caching modes:

- `read_through`: (Default) Checks cache first, calls LLM on miss, then stores the result.
- `bypass`: Completely ignores the cache for both reading and writing.
- `refresh`: Forces a fresh LLM call and updates the cache with the new value.

```typescript
const result = await llm.callText({
	promptId: "expensive_query",
	cache: { mode: "read_through", ttlSeconds: 3600 },
});
```

## Learn by example

The [`examples/`](examples/) directory contains copy-paste-ready examples for every realistic integration shape — from a first call through custom providers, production pipelines, and framework integrations.

**Curated starting points:**

- [RAG pipeline](examples/rag-pipeline.md) — embed → retrieve → rerank → generate, end-to-end
- [Tool-using agent](examples/agent-with-tools.md) — ReAct-style agent with calculator and search tools
- [Custom provider — Anthropic](src/llm-service/examples/extensions/custom-provider-anthropic.md) — complete `LLMProvider` implementation with `@anthropic-ai/sdk`
- [Circuit breaker policy](src/orchestrator/examples/extensions/custom-policy-circuit-breaker.md) — resilient production pipelines that degrade gracefully
- [Streaming UI server](examples/streaming-ui-server.md) — Express SSE handler with client-disconnect cancellation

Browse the full index: [examples/README.md](examples/README.md)

---

## 📄 License

MIT © [MotleyWildside](https://github.com/MotleyWildside)
