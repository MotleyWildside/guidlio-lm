# Caching

The service has a built-in read-through / refresh cache. The default provider is `InMemoryCacheProvider`; swap it for any implementation of the `CacheProvider` interface (Redis, Memcached, etc.).

## Cache modes

| Mode | Reads cache? | Writes cache? | Use case |
| :--- | :--- | :--- | :--- |
| `"read_through"` | Yes | Yes (on miss) | Normal caching — avoids duplicate API calls |
| `"refresh"` | No | Yes | Force-update a stale entry while keeping it hot for future callers |
| `"bypass"` | No | No | Always call the provider; useful for sensitive or unique requests |

Cache is only written when `ttlSeconds` is also set. Without a TTL the entry never expires.

## Basic read-through

```typescript
import { LLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";

const llm = new LLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});

// First call: miss → calls provider → stores result for 1 hour
const first = await llm.callText({
	promptId: "summarize",
	variables: { text },
	cache: { mode: "read_through", ttlSeconds: 3600 },
});

// Second call with identical params: hit → no provider call
const second = await llm.callText({
	promptId: "summarize",
	variables: { text },
	cache: { mode: "read_through", ttlSeconds: 3600 },
});

console.log(second.durationMs); // near zero — served from cache
```

## Idempotency keys

By default the cache key is a hash of `promptId + version + variables + resolvedModel + temperature + …`. Supply an `idempotencyKey` when you want a human-controlled key (e.g. tied to a database record ID), so you can bust it explicitly.

```typescript
await llm.callText({
	promptId: "summarize",
	variables: { text },
	idempotencyKey: `article:${articleId}`,
	cache: { mode: "read_through", ttlSeconds: 86400 },
});
```

## Refreshing a stale entry

```typescript
// Re-run the prompt and update the cached value — callers after this see the fresh result
await llm.callText({
	promptId: "summarize",
	variables: { text: updatedText },
	idempotencyKey: `article:${articleId}`,
	cache: { mode: "refresh", ttlSeconds: 86400 },
});
```

## Disabling the cache globally

Set `enableCache: false` in the service config to disable reads and writes regardless of per-call `cache` params. Useful in test environments.

```typescript
const llm = new LLMService({
	providers: [...],
	enableCache: false,
	promptRegistry: registry,
});
```

## Custom cache provider (Redis example)

Implement the `CacheProvider` interface and inject it at construction.

```typescript
import type { CacheProvider } from "guidlio-lm";
import { createClient } from "redis";

class RedisCacheProvider implements CacheProvider {
	private client = createClient({ url: process.env.REDIS_URL });

	async get<T>(key: string): Promise<T | null> {
		const raw = await this.client.get(key);
		return raw ? (JSON.parse(raw) as T) : null;
	}

	async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
		const opts = ttlSeconds ? { EX: ttlSeconds } : undefined;
		await this.client.set(key, JSON.stringify(value), opts);
	}

	async delete(key: string): Promise<void> {
		await this.client.del(key);
	}

	async clear(): Promise<void> {
		await this.client.flushDb();
	}
}

const llm = new LLMService({
	providers: [...],
	cacheProvider: new RedisCacheProvider(),
	promptRegistry: registry,
});
```

## Cache key composition

Two calls share a cache entry only when **all** of the following match:

- `promptId`, `promptVersion`
- `variables` (JSON-serialized)
- Resolved model (after applying `params.model → prompt defaults → config.defaultModel`)
- `temperature`, `maxTokens`, `topP`, `seed`
- `idempotencyKey`
- Response format (`"text"` vs `"json"`)
- Zod schema fingerprint (for `callJSON`)

Changing any of these produces a different key. Explicit `idempotencyKey` is also part of the key, so two calls with different `idempotencyKey` values never share an entry.
