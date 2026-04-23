# Idempotency and Cache Keys

The cache key controls when two calls share a cached result and when they are treated as distinct. Understanding how the key is composed — and when to supply your own `idempotencyKey` — prevents both stale-result bugs and missed cache hits.

**Concepts covered:**
- What fields compose the cache key
- Why `temperature: 0` is a distinct key from temperature unset
- When to supply `idempotencyKey`: webhooks, user-visible retries, batch jobs
- What NOT to use as an idempotency key
- Full webhook handler example

---

## Cache key composition

The cache key is the sha256 hash of the following fields, pipe-delimited:

```
sha256(idempotencyKey | promptId | version | JSON(variables) | model | temperature)
```

Two calls share a cache entry only when every one of these factors is identical. Changing any field — even temperature by 0.01 — produces a different key and a fresh provider call.

| Field | Note |
| :--- | :--- |
| `idempotencyKey` | Empty string when not supplied |
| `promptId` | Matches the registered prompt |
| `version` | Resolved version (e.g. `"latest"` resolves to `2` before hashing) |
| `JSON(variables)` | Deterministic JSON serialization of the variables object |
| `model` | Resolved model after applying prompt defaults and `config.defaultModel` |
| `temperature` | Uses a **nullish** check — `0` is a distinct value from unset |

---

## temperature: 0 is distinct from unset

A common surprise: `temperature: 0` (deterministic sampling) produces a **different cache key** than omitting `temperature` entirely. The service uses a nullish check (`?? undefined`) not a falsy check, so `0` is treated as an explicit value.

```typescript
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";

const registry = new PromptRegistry();

registry.register({
	promptId: "classify",
	version: 1,
	userPrompt: "Classify the sentiment of: {text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.2 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});

// These three calls produce THREE DIFFERENT cache keys:

// key A — temperature omitted; model default (0.2) is used
await llm.callText({
	promptId: "classify",
	variables: { text: "Great product!" },
	cache: { mode: "read_through", ttlSeconds: 3600 },
});

// key B — temperature: 0 explicitly set (deterministic)
await llm.callText({
	promptId: "classify",
	variables: { text: "Great product!" },
	temperature: 0,
	cache: { mode: "read_through", ttlSeconds: 3600 },
});

// key C — temperature: 0.2 matches the prompt default but is now explicit
await llm.callText({
	promptId: "classify",
	variables: { text: "Great product!" },
	temperature: 0.2,
	cache: { mode: "read_through", ttlSeconds: 3600 },
});
```

If you want deterministic results AND cache hits to coalesce, always pass the same explicit `temperature` value rather than relying on the prompt default.

---

## When to supply idempotencyKey

### Webhook processing

Webhook providers often deliver the same event more than once (at-least-once delivery). Use the event's own ID as the `idempotencyKey` so that a retried delivery hits the cache instead of calling the provider again.

```typescript
interface WebhookEvent {
	id: string;
	type: string;
	payload: { body: string };
}

async function handleWebhook(event: WebhookEvent): Promise<void> {
	const result = await llm.callText({
		promptId: "moderate-content",
		variables: { body: event.payload.body },
		// The event ID is stable across retried deliveries — subsequent calls
		// with the same event.id return the cached result immediately
		idempotencyKey: event.id,
		cache: { mode: "read_through", ttlSeconds: 86400 },
	});

	await db.storeDecision(event.id, result.text);
}
```

### User-visible retry

When a user clicks "regenerate" or hits reload, you usually want a fresh LLM call — not a cached one. But if your UI has a "retry failed request" flow where you want to guarantee the user sees the same answer on the second attempt, bind the idempotency key to the request session.

```typescript
// Same session ID → same answer on reload (cache hit)
// New request → new session ID → fresh call
await llm.callText({
	promptId: "recommend",
	variables: { userId, preferences },
	idempotencyKey: `session:${sessionId}:recommend`,
	cache: { mode: "read_through", ttlSeconds: 1800 },
});
```

### Batch job item

In a batch pipeline, use the item's database row ID. If the job is interrupted and restarted, completed items are served from cache and the job resumes where it left off.

```typescript
async function processArticles(articleIds: string[]): Promise<void> {
	for (const articleId of articleIds) {
		const article = await db.getArticle(articleId);

		const result = await llm.callText({
			promptId: "summarize",
			variables: { text: article.body },
			// Idempotent across job restarts — same row ID, same cached result
			idempotencyKey: `article:${articleId}`,
			cache: { mode: "read_through", ttlSeconds: 604800 }, // 1 week
		});

		await db.storeSummary(articleId, result.text);
	}
}
```

---

## What NOT to use as idempotencyKey

| Bad key | Why |
| :--- | :--- |
| `crypto.randomUUID()` per call | A new UUID every time means zero cache hits — defeats caching entirely |
| `Date.now()` or `new Date().toISOString()` | Timestamp changes every millisecond — same problem |
| Current Unix timestamp rounded to the hour | Creates cache partitions by time but is fragile and hard to reason about |

If you need a fresh call every time, use `cache: { mode: "bypass" }` or omit the `cache` param instead of manufacturing a unique key.

---

## Refreshing a stale entry

`mode: "refresh"` forces a fresh provider call and overwrites the cached value. Use it when the source content changes and you want all future callers to see the updated result.

```typescript
// Article was updated — force a fresh summary and warm the cache for future readers
await llm.callText({
	promptId: "summarize",
	variables: { text: updatedArticle.body },
	idempotencyKey: `article:${updatedArticle.id}`,
	cache: { mode: "refresh", ttlSeconds: 604800 },
});
```

---

## What to change next

- [06-caching.md](./06-caching.md) — full caching reference including custom `CacheProvider` implementations
- [08-cancellation-and-timeouts.md](./08-cancellation-and-timeouts.md) — combine an `idempotencyKey` with `AbortSignal` for resilient webhook handlers
