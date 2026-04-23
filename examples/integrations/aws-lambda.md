# AWS Lambda Integration

Running `guidlio-lm` in AWS Lambda: initializing the service outside the handler for warm-start reuse, externalizing the cache to Redis/ElastiCache so it survives cold starts, and deriving an `AbortSignal` from `context.getRemainingTimeInMillis()`.

**Concepts covered:**
- Module-level singleton for warm-instance reuse
- Externalized `CacheProvider` (Redis) so cache survives between invocations
- `context.getRemainingTimeInMillis()` → `AbortSignal` with a safety buffer
- Environment variable wiring for API keys

---

## Service initialization (outside the handler)

Lambda freezes the execution environment between invocations and thaws it for the next one. Any object initialized at module scope persists across warm invocations.

```typescript
// src/llm.ts
import { GuidlioLMService, OpenAIProvider, PromptRegistry, CacheProvider } from "guidlio-lm";
import Redis from "ioredis";

// ── Redis-backed cache ─────────────────────────────────────────────────────
// Survives cold starts — InMemoryCacheProvider would not.
const redis = new Redis(process.env.REDIS_URL!);

const redisCache: CacheProvider = {
	async get<T>(key: string): Promise<T | null> {
		try {
			const raw = await redis.get(key);
			return raw ? (JSON.parse(raw) as T) : null;
		} catch {
			return null; // degrade to uncached on connection error
		}
	},

	async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
		try {
			const serialized = JSON.stringify(value);
			if (ttlSeconds) {
				await redis.set(key, serialized, "EX", ttlSeconds);
			} else {
				await redis.set(key, serialized);
			}
		} catch {
			// don't crash the handler on cache write failures
		}
	},

	async delete(key: string): Promise<void> {
		try { await redis.del(key); } catch { /* ignore */ }
	},

	async clear(): Promise<void> {
		// intentionally not implemented — no FLUSHDB in production
	},
};

// ── Prompt registry ────────────────────────────────────────────────────────
const registry = new PromptRegistry();

registry.register({
	promptId: "summarize",
	version: 1,
	systemPrompt: "Summarize in at most three sentences.",
	userPrompt: "{text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
	output: { type: "text" },
});

// ── Service singleton ──────────────────────────────────────────────────────
export const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
	cacheProvider: redisCache,
});
```

---

## Handler with deadline-derived AbortSignal

```typescript
// src/handler.ts
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { llm } from "./llm";
import { LLMTransientError } from "guidlio-lm";

export const handler: APIGatewayProxyHandlerV2 = async (event, context) => {
	const body = JSON.parse(event.body ?? "{}") as { text?: string };
	if (!body.text?.trim()) {
		return { statusCode: 400, body: JSON.stringify({ error: "text is required" }) };
	}

	// Derive a signal from Lambda's remaining time so we can abort the LLM call
	// cleanly before Lambda kills the process. 500 ms buffer for cleanup.
	const controller = new AbortController();
	const remainingMs = context.getRemainingTimeInMillis();
	const timer = setTimeout(
		() => controller.abort(new Error("lambda_deadline")),
		remainingMs - 500,
	);

	try {
		const result = await llm.callText({
			promptId: "summarize",
			variables: { text: body.text },
			traceId: context.awsRequestId, // reuse Lambda request ID as traceId
			signal: controller.signal,
			cache: { mode: "read_through", ttlSeconds: 3_600 },
		});

		return {
			statusCode: 200,
			headers: { "Content-Type": "application/json", "x-trace-id": result.traceId },
			body: JSON.stringify({ summary: result.text }),
		};
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			return { statusCode: 504, body: JSON.stringify({ error: "handler timed out" }) };
		}
		if (err instanceof LLMTransientError) {
			return { statusCode: 503, body: JSON.stringify({ error: "service temporarily unavailable" }) };
		}
		return { statusCode: 500, body: JSON.stringify({ error: "internal server error" }) };
	} finally {
		clearTimeout(timer); // prevent the timer from firing after a fast response
	}
};
```

---

## Environment variable checklist

| Variable | Where to set | Description |
| :--- | :--- | :--- |
| `OPENAI_API_KEY` | Lambda env / Secrets Manager | Provider API key |
| `REDIS_URL` | Lambda env / Secrets Manager | `redis://...` connection string |

Use AWS Secrets Manager or Parameter Store for secrets; inject them via Lambda environment variables or the AWS SDK at init time.

---

## What to change next

- [custom-cache-redis.md](../../src/llm-service/examples/extensions/custom-cache-redis.md) — full Redis `CacheProvider` with namespacing and `clear()`
- [08-cancellation-and-timeouts.md](../../src/llm-service/examples/08-cancellation-and-timeouts.md) — `AbortSignal` patterns and deadline wrapping
