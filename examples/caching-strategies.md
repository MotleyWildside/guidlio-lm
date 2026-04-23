# Caching Strategies

Different prompt categories have different caching needs. Classification prompts produce the same answer for the same input, so a long-lived cache entry saves significant cost. Personalized chat responses are unique per user session and should never be cached. This example shows how to pick a caching strategy per prompt category, when to force-refresh a stale entry, and when to stay out of the cache entirely.

**Concepts covered:**
- `"read_through"` for deterministic, reusable responses
- `"refresh"` to force-update a stale cache entry while keeping it warm for other callers
- `"bypass"` (or omitting `cache`) for personalized and streaming responses
- TTL tuning per prompt category
- Why `temperature: 0` matters for cache key stability

---

## The three categories

```typescript
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";

const registry = new PromptRegistry();

// ── Classification ─────────────────────────────────────────────────────────
// Same input → same output. Cache aggressively.
registry.register({
	promptId: "classify-intent",
	version: 1,
	systemPrompt: "Classify the user intent as one of: question, complaint, praise, other.",
	userPrompt: "Message: {text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0 }, // temperature: 0 = stable cache key
	output: { type: "json" },
});

// ── Extraction ─────────────────────────────────────────────────────────────
// Extracts facts from a source document. Refresh when source updates.
registry.register({
	promptId: "extract-metadata",
	version: 1,
	systemPrompt: "Extract structured metadata from this document.",
	userPrompt: "{document}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0 },
	output: { type: "json" },
});

// ── Personalized chat ──────────────────────────────────────────────────────
// Every session is unique. Do not cache.
registry.register({
	promptId: "chat-reply",
	version: 1,
	systemPrompt: "You are a helpful assistant. Respond naturally to the user.",
	userPrompt: "{userMessage}",
	modelDefaults: { model: "gpt-4o", temperature: 0.8 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});
```

---

## Classification: aggressive read-through

```typescript
import { z } from "zod";

const IntentSchema = z.object({ intent: z.enum(["question", "complaint", "praise", "other"]) });

// First call: miss → calls provider → stores for 24 h
// Subsequent identical calls: hit → near-zero latency
const classification = await llm.callJSON({
	promptId: "classify-intent",
	variables: { text: "Where can I find my invoice?" },
	jsonSchema: IntentSchema,
	cache: { mode: "read_through", ttlSeconds: 86_400 },
});

console.log(classification.data.intent); // "question"
```

**Why 24 h?** The classification model and prompt don't change often. Even if they do, the next cache miss will populate the new answer automatically.

**Why `temperature: 0`?** Temperature is part of the cache key. At `temperature: 0`, two identical calls always produce the same output, so sharing a cache entry is safe. At `temperature > 0`, two calls with the same input will produce different outputs — caching them without an explicit `idempotencyKey` would serve stale, potentially different answers to future callers.

---

## Extraction: medium TTL, refresh on source update

```typescript
// Normal read (serve from cache if fresh)
const extracted = await llm.callJSON({
	promptId: "extract-metadata",
	variables: { document: docText },
	idempotencyKey: `doc:${docId}`,
	cache: { mode: "read_through", ttlSeconds: 3_600 }, // 1 h
});

// Source document was updated — force a fresh extraction and repopulate the cache
async function refreshDocumentCache(docId: string, updatedText: string): Promise<void> {
	await llm.callJSON({
		promptId: "extract-metadata",
		variables: { document: updatedText },
		idempotencyKey: `doc:${docId}`,
		cache: { mode: "refresh", ttlSeconds: 3_600 },
		// refresh: skips reading cache, calls provider, writes the result back
	});
}
```

`"refresh"` is the correct mode when you know the cached value is stale but want to keep the cache warm for other callers. It always calls the provider and overwrites the cache entry — future `read_through` calls on the same key will see the new value immediately.

---

## Personalized chat: no cache

```typescript
// No `cache` param = no read, no write
const reply = await llm.callText({
	promptId: "chat-reply",
	variables: { userMessage: "Tell me a joke about TypeScript." },
	traceId: sessionId,
});
```

**Streaming is always uncached.** `callStream` ignores `cache` and `idempotencyKey` params and emits a warning if you pass them. There is nothing to cache on a stream until it completes, and by then the caller has already consumed it.

---

## When NOT to cache

| Scenario | Reason |
| :--- | :--- |
| Streaming responses | Streams cannot be read from cache; param is ignored with a warning |
| Personalized outputs (user name, session history) | Unique per caller — a cache hit would serve the wrong content |
| `temperature > 0` without `idempotencyKey` | Non-deterministic outputs shouldn't be served to future callers |
| Rapidly changing data (live prices, sensor readings) | Cache TTL can't keep up; set `enableCache: false` or use `"bypass"` |

---

## What to change next

- [09-idempotency-and-cache-keys.md](../src/llm-service/examples/09-idempotency-and-cache-keys.md) — how the cache key is composed and when to supply `idempotencyKey`
- [custom-cache-redis.md](../src/llm-service/examples/extensions/custom-cache-redis.md) — persisting the cache across restarts with Redis
