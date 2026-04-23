# Batch Job with Idempotency Keys

Long-running batch jobs that call LLMs are expensive to restart from scratch. By combining `idempotencyKey` with `cache: { mode: "read_through" }`, you get a restart-safe processor: items already completed on a previous run are served from cache, and only the remaining items hit the API.

**Concepts covered:**
- `idempotencyKey` tied to a stable item identifier for deterministic cache keys
- `cache: { mode: "read_through", ttlSeconds }` for restart-safe processing
- Token usage aggregation across a batch for cost tracking
- Serial processing with `for...of` to respect rate limits
- Parallel batching with a simple concurrency limiter
- Redis-backed `CacheProvider` for persistence across process restarts

---

## Setup

```typescript
import {
	GuidlioLMService,
	OpenAIProvider,
	PromptRegistry,
	ConsoleLogger,
	type CacheProvider,
} from "guidlio-lm";
import { createClient, type RedisClientType } from "redis";

// Redis-backed cache — survives process restarts, shared across workers
class RedisCacheProvider implements CacheProvider {
	private client: RedisClientType;

	constructor(url: string) {
		this.client = createClient({ url }) as RedisClientType;
	}

	async connect(): Promise<void> {
		await this.client.connect();
	}

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

const cacheProvider = new RedisCacheProvider(process.env.REDIS_URL ?? "redis://localhost:6379");
await cacheProvider.connect();

const registry = new PromptRegistry();

registry.register({
	promptId: "summarize_article",
	version: 1,
	systemPrompt: "You are a concise summarizer. Summarize in 2-3 sentences.",
	userPrompt: "Article:\n\n{text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0 },
	output: { type: "text" },
});

const logger = new ConsoleLogger();

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
	cacheProvider,
	logger,
});
```

---

## Batch item type

```typescript
interface BatchItem {
	itemId: string;
	text: string;
}

interface BatchResult {
	itemId: string;
	summary: string;
	tokensUsed: number;
	cached: boolean;
}
```

---

## Serial processor (safe for rate-limited APIs)

`for...of` with `await` naturally serializes calls, ensuring you never exceed your provider's requests-per-minute limit.

```typescript
async function processBatchSerial(items: BatchItem[]): Promise<BatchResult[]> {
	const results: BatchResult[] = [];
	let totalTokens = 0;

	for (const item of items) {
		try {
			const result = await llm.callText({
				promptId: "summarize_article",
				variables: { text: item.text },
				// Tie the cache key to the item ID — stable across restarts
				idempotencyKey: `article:${item.itemId}`,
				cache: { mode: "read_through", ttlSeconds: 86400 },
			});

			const tokens = result.usage?.totalTokens ?? 0;
			totalTokens += tokens;

			logger.info("item processed", {
				itemId: item.itemId,
				tokens,
				durationMs: result.durationMs,
			});

			results.push({
				itemId: item.itemId,
				summary: result.text,
				tokensUsed: tokens,
				// durationMs near zero indicates a cache hit
				cached: result.durationMs < 5,
			});
		} catch (err) {
			logger.error("item failed", {
				itemId: item.itemId,
				error: err instanceof Error ? err.message : String(err),
			});
			// Continue processing remaining items rather than aborting the batch
		}
	}

	logger.info("batch complete", { total: items.length, totalTokens });
	return results;
}
```

---

## Parallel processor with concurrency limit

For batches that can tolerate parallel calls, a concurrency limiter prevents flooding the provider while still processing multiple items simultaneously.

```typescript
// Minimal concurrency limiter — no external dependency required
function pLimit(concurrency: number) {
	let active = 0;
	const queue: Array<() => void> = [];

	function next(): void {
		if (active >= concurrency || queue.length === 0) return;
		active++;
		const run = queue.shift()!;
		run();
	}

	return function limit<T>(fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			queue.push(() => {
				fn()
					.then(resolve, reject)
					.finally(() => {
						active--;
						next();
					});
			});
			next();
		});
	};
}

async function processBatchParallel(
	items: BatchItem[],
	concurrency = 5,
): Promise<BatchResult[]> {
	const limit = pLimit(concurrency);
	let totalTokens = 0;

	const results = await Promise.allSettled(
		items.map((item) =>
			limit(async () => {
				const result = await llm.callText({
					promptId: "summarize_article",
					variables: { text: item.text },
					idempotencyKey: `article:${item.itemId}`,
					cache: { mode: "read_through", ttlSeconds: 86400 },
				});

				totalTokens += result.usage?.totalTokens ?? 0;

				return {
					itemId: item.itemId,
					summary: result.text,
					tokensUsed: result.usage?.totalTokens ?? 0,
					cached: result.durationMs < 5,
				} satisfies BatchResult;
			}),
		),
	);

	logger.info("parallel batch complete", { total: items.length, totalTokens });

	return results
		.filter((r): r is PromiseFulfilledResult<BatchResult> => r.status === "fulfilled")
		.map((r) => r.value);
}
```

---

## Running the batch

```typescript
const articles: BatchItem[] = [
	{ itemId: "art-001", text: "TypeScript 5.0 introduces const type parameters..." },
	{ itemId: "art-002", text: "Node.js 22 ships with a native test runner..." },
	{ itemId: "art-003", text: "The latest GPT-4 models support tool calling..." },
];

// First run: all cache misses, API is called for each item
const run1 = await processBatchSerial(articles);
console.log("Run 1 — cached:", run1.filter((r) => r.cached).length); // 0

// Second run: all cache hits, no API calls
const run2 = await processBatchSerial(articles);
console.log("Run 2 — cached:", run2.filter((r) => r.cached).length); // 3
```

---

## What to change next

- [Caching strategies](caching-strategies.md) — when to use `read_through`, `refresh`, and no cache
- [Cost guardrails](cost-guardrails.md) — abort the batch when cumulative token spend exceeds a budget
