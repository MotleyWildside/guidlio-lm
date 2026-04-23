# Custom Cache Provider — Redis (ioredis)

The built-in `InMemoryCacheProvider` is lost on process restart and is not shared across multiple service instances. For production deployments with more than one process you need a shared, persistent cache. This example shows how to back `CacheProvider` with Redis using the `ioredis` client, including connection-failure fallback so a Redis outage degrades to uncached behaviour rather than crashing requests.

## Concepts covered

- Implementing the `CacheProvider` interface against `ioredis`
- Setting TTL with `redis.set(key, value, "EX", ttlSeconds)`
- Deserialising values with `JSON.parse` on `get`
- Wrapping every method in try/catch so Redis failures degrade gracefully
- Key namespacing with a configurable prefix to isolate environments
- Wiring the provider into `GuidlioLMServiceConfig.cacheProvider`

## Installation

`ioredis` is a peer dependency — install it alongside `guidlio-lm`:

```bash
npm install ioredis
```

## Implementation

```typescript
import Redis from "ioredis";
import type { CacheProvider, LLMLogger } from "guidlio-lm";

interface RedisCacheProviderOptions {
	// All cache keys are prefixed with this string.
	// Use a version suffix (e.g. "llm:v1:") to invalidate the entire cache on schema changes.
	namespace?: string;
	// Optional logger — connection errors are logged as warnings, not thrown
	logger?: LLMLogger;
}

export class RedisCacheProvider implements CacheProvider {
	private redis: Redis;
	private namespace: string;
	private logger?: LLMLogger;

	constructor(redis: Redis, options: RedisCacheProviderOptions = {}) {
		this.redis = redis;
		this.namespace = options.namespace ?? "llm:v1:";
		this.logger = options.logger;
	}

	async get<T>(key: string): Promise<T | null> {
		try {
			const raw = await this.redis.get(this.ns(key));
			if (!raw) return null;
			return JSON.parse(raw) as T;
		} catch (err) {
			// A Redis read failure must never crash the caller — degrade to a cache miss
			this.logger?.warn("RedisCacheProvider.get failed — treating as cache miss", {
				key,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
		try {
			const serialised = JSON.stringify(value);
			if (ttlSeconds !== undefined && ttlSeconds > 0) {
				// "EX" sets an absolute TTL in whole seconds
				await this.redis.set(this.ns(key), serialised, "EX", ttlSeconds);
			} else {
				// No TTL — entry persists until explicitly deleted or the key evicts under memory pressure
				await this.redis.set(this.ns(key), serialised);
			}
		} catch (err) {
			this.logger?.warn("RedisCacheProvider.set failed — result will not be cached", {
				key,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async delete(key: string): Promise<void> {
		try {
			await this.redis.del(this.ns(key));
		} catch (err) {
			this.logger?.warn("RedisCacheProvider.delete failed", {
				key,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async clear(): Promise<void> {
		// Scan and delete only keys under our namespace rather than flushing the entire DB.
		// This is safe to run in a shared Redis instance.
		try {
			let cursor = "0";
			do {
				const [nextCursor, keys] = await this.redis.scan(
					cursor,
					"MATCH",
					`${this.namespace}*`,
					"COUNT",
					100,
				);
				cursor = nextCursor;
				if (keys.length > 0) {
					await this.redis.del(...keys);
				}
			} while (cursor !== "0");
		} catch (err) {
			this.logger?.warn("RedisCacheProvider.clear failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Prepend the namespace so keys never collide with other applications using the same Redis
	private ns(key: string): string {
		return `${this.namespace}${key}`;
	}
}
```

## Wiring into GuidlioLMService

```typescript
import Redis from "ioredis";
import { GuidlioLMService, OpenAIProvider, PromptRegistry, ConsoleLogger } from "guidlio-lm";
import { RedisCacheProvider } from "./RedisCacheProvider";

const redis = new Redis(process.env.REDIS_URL!);
const logger = new ConsoleLogger();

const cacheProvider = new RedisCacheProvider(redis, {
	namespace: "llm:v1:",
	logger,
});

const registry = new PromptRegistry();
registry.register({
	promptId: "summarize",
	version: 1,
	systemPrompt: "Summarize the following text in one paragraph.",
	userPrompt: "{text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	cacheProvider,
	logger,
	promptRegistry: registry,
});

// First call: cache miss — calls OpenAI, stores result for 1 hour
const result = await llm.callText({
	promptId: "summarize",
	variables: { text: "The history of the Roman Empire..." },
	cache: { mode: "read_through", ttlSeconds: 3600 },
});

console.log(result.text);
```

## Graceful connection failure

If Redis is unavailable at startup or becomes unreachable mid-flight, every `CacheProvider` method returns `null` (for `get`) or silently no-ops (for `set` / `delete` / `clear`) and logs a warning. The service continues making real provider calls as if the cache did not exist — no error reaches the caller.

To assert this in a test, close the Redis connection before calling the service:

```typescript
await redis.quit();

// This call reaches OpenAI directly — no error thrown
const result = await llm.callText({
	promptId: "summarize",
	variables: { text: "..." },
	cache: { mode: "read_through", ttlSeconds: 60 },
});
```

## Namespace strategy

Use a versioned prefix (`"llm:v2:"`) whenever you change the structure of cached values — prompt template changes, model upgrades, or schema changes. Old keys under the previous prefix expire naturally according to their TTL.

```typescript
// Deploy: bump namespace to invalidate all stale v1 entries immediately
const cacheProvider = new RedisCacheProvider(redis, { namespace: "llm:v2:" });
```

## What to change next

- If you don't need shared or persistent caching, use the bounded in-memory alternative instead — see [custom-cache-lru-bounded.md](./custom-cache-lru-bounded.md).
- See all cache modes (`read_through`, `refresh`, `bypass`) in action — see [06-caching.md](../06-caching.md).
