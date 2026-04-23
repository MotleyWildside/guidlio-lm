# Custom Cache Provider — LRU-Bounded In-Memory

The built-in `InMemoryCacheProvider` grows without bound — in a long-running server that calls many unique prompts, each producing a distinct cache key, memory usage climbs indefinitely. This example shows how to implement `CacheProvider` with a fixed-capacity LRU (Least Recently Used) eviction policy and per-entry TTL expiry, so memory stays within a predictable ceiling regardless of how many unique keys the service generates.

## Concepts covered

- Implementing `CacheProvider` with a `Map`-based LRU (move-to-front on access, evict oldest on insert)
- Per-entry TTL tracking using `setTimeout`
- Configurable `maxEntries` constructor option with a sensible default
- Why this matters for long-running servers with high prompt cardinality
- No external dependencies — pure TypeScript

## Implementation

```typescript
import type { CacheProvider } from "guidlio-lm";

interface CacheEntry<T> {
	value: T;
	// Handle returned by setTimeout so we can cancel on delete/clear
	expiryTimer: ReturnType<typeof setTimeout> | null;
}

interface LruCacheProviderOptions {
	// Maximum number of entries to hold simultaneously. When the limit is reached,
	// the least recently used entry is evicted to make room for the new one.
	maxEntries?: number;
}

export class LruCacheProvider implements CacheProvider {
	private readonly maxEntries: number;

	// Map preserves insertion order. Entries are moved to the end on access,
	// so the oldest (least recently used) entry is always at the front.
	private store = new Map<string, CacheEntry<unknown>>();

	constructor({ maxEntries = 500 }: LruCacheProviderOptions = {}) {
		if (maxEntries < 1) throw new RangeError("maxEntries must be >= 1");
		this.maxEntries = maxEntries;
	}

	async get<T>(key: string): Promise<T | null> {
		const entry = this.store.get(key);
		if (!entry) return null;

		// Move to end of Map to mark as most recently used
		this.store.delete(key);
		this.store.set(key, entry as CacheEntry<unknown>);

		return entry.value as T;
	}

	async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
		// If the key already exists, remove it so we can re-insert at the end (most recent)
		const existing = this.store.get(key);
		if (existing) {
			if (existing.expiryTimer !== null) clearTimeout(existing.expiryTimer);
			this.store.delete(key);
		}

		// Evict the oldest entry when the store is at capacity
		if (this.store.size >= this.maxEntries) {
			// Map iterator visits keys in insertion order — first key is the oldest
			const oldestKey = this.store.keys().next().value;
			if (oldestKey !== undefined) {
				const oldest = this.store.get(oldestKey);
				if (oldest?.expiryTimer !== null && oldest?.expiryTimer !== undefined) {
					clearTimeout(oldest.expiryTimer);
				}
				this.store.delete(oldestKey);
			}
		}

		let expiryTimer: ReturnType<typeof setTimeout> | null = null;

		if (ttlSeconds !== undefined && ttlSeconds > 0) {
			// Schedule automatic eviction. unref() prevents the timer from keeping the
			// Node.js event loop alive when the process is otherwise idle.
			expiryTimer = setTimeout(() => {
				this.store.delete(key);
			}, ttlSeconds * 1000);

			if (typeof expiryTimer === "object" && "unref" in expiryTimer) {
				(expiryTimer as { unref(): void }).unref();
			}
		}

		this.store.set(key, { value, expiryTimer });
	}

	async delete(key: string): Promise<void> {
		const entry = this.store.get(key);
		if (entry) {
			if (entry.expiryTimer !== null) clearTimeout(entry.expiryTimer);
			this.store.delete(key);
		}
	}

	async clear(): Promise<void> {
		for (const entry of this.store.values()) {
			if (entry.expiryTimer !== null) clearTimeout(entry.expiryTimer);
		}
		this.store.clear();
	}

	// Useful for monitoring and tests
	get size(): number {
		return this.store.size;
	}
}
```

## Wiring into GuidlioLMService

```typescript
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";
import { LruCacheProvider } from "./LruCacheProvider";

const registry = new PromptRegistry();
registry.register({
	promptId: "tag",
	version: 1,
	systemPrompt: "Return a comma-separated list of topic tags for the text.",
	userPrompt: "{text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0 },
	output: { type: "text" },
});

// Hold at most 1000 unique prompt results in memory; evict oldest on overflow
const cacheProvider = new LruCacheProvider({ maxEntries: 1000 });

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	cacheProvider,
	promptRegistry: registry,
});

// The cache never grows beyond 1000 entries regardless of how many unique texts are processed
for (const article of articles) {
	const result = await llm.callText({
		promptId: "tag",
		variables: { text: article },
		cache: { mode: "read_through", ttlSeconds: 3600 },
	});
	console.log(result.text);
}

console.log(`Cache size: ${cacheProvider.size}`); // <= 1000
```

## LRU eviction order

The eviction invariant: when the store reaches `maxEntries`, the entry that was accessed (read or written) least recently is removed. This preserves the most useful entries for hot prompts while discarding stale ones.

```typescript
const cache = new LruCacheProvider({ maxEntries: 3 });

await cache.set("a", "alpha");
await cache.set("b", "beta");
await cache.set("c", "gamma");

// Touch "a" so it becomes the most recently used
await cache.get("a");

// Adding a fourth entry evicts "b" (oldest untouched), not "a"
await cache.set("d", "delta");

console.log(await cache.get("b")); // null — evicted
console.log(await cache.get("a")); // "alpha" — still present
```

## TTL and memory

Each entry schedules a `setTimeout` for its TTL. The timer is cancelled on `delete` and `clear` to avoid memory leaks. If a TTL entry is evicted by LRU pressure before the timer fires, the timer is also cancelled at eviction time.

## When to use this vs InMemoryCacheProvider

Use `LruCacheProvider` when:

- Your service runs as a long-lived process (server, daemon, Lambda with large reserved memory).
- You call the service with a large variety of prompt inputs (high key cardinality).
- You want a predictable RSS ceiling without needing a Redis deployment.

Use the built-in `InMemoryCacheProvider` for short-lived processes, scripts, or when total unique inputs are bounded and known to be small.

## What to change next

- For a shared, persistent cache across multiple processes, use the Redis-backed provider instead — see [custom-cache-redis.md](./custom-cache-redis.md).
- See all cache modes and key composition rules — see [06-caching.md](../06-caching.md).
