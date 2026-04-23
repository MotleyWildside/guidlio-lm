# Cloudflare Workers Integration

Running `guidlio-lm` in the Cloudflare Workers runtime: which providers work, which runtime APIs need polyfills, and a KV-backed `CacheProvider` implementation.

**Concepts covered:**
- Which providers are fetch-based and work in Workers
- `nodejs_compat` flag for Node.js built-in shims (`crypto.randomUUID`)
- KV-backed `CacheProvider` using `env.KV`
- Request handling in the Workers fetch handler

---

## Provider compatibility

All three built-in providers (`OpenAIProvider`, `GeminiProvider`, `OpenRouterProvider`) use `fetch` internally — they work in Workers without modification.

```typescript
// All of these work in Workers:
import { OpenAIProvider, GeminiProvider, OpenRouterProvider } from "guidlio-lm";
```

The Workers runtime includes the Web Fetch API but not Node.js built-ins by default. `guidlio-lm` imports `randomUUID` from the Node.js `"crypto"` module internally. Enable the `nodejs_compat` compatibility flag to shim it.

**`wrangler.toml`:**
```toml
name = "my-llm-worker"
main = "src/worker.ts"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "LLM_CACHE"
id = "your-kv-namespace-id"
```

---

## KV-backed cache provider

```typescript
// src/kvCache.ts
import type { KVNamespace } from "@cloudflare/workers-types";
import type { CacheProvider } from "guidlio-lm";

export class KVCacheProvider implements CacheProvider {
	constructor(private kv: KVNamespace, private prefix = "llm:v1:") {}

	async get<T>(key: string): Promise<T | null> {
		const raw = await this.kv.get(this.prefix + key, "text");
		return raw ? (JSON.parse(raw) as T) : null;
	}

	async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
		const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
		await this.kv.put(this.prefix + key, JSON.stringify(value), opts);
	}

	async delete(key: string): Promise<void> {
		await this.kv.delete(this.prefix + key);
	}

	async clear(): Promise<void> {
		// KV list + delete in a loop — use sparingly; prefer key-scoped deletes in production
		const list = await this.kv.list({ prefix: this.prefix });
		await Promise.all(list.keys.map((k) => this.kv.delete(k.name)));
	}
}
```

---

## Worker handler

```typescript
// src/worker.ts
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";
import { KVCacheProvider } from "./kvCache";
import type { Env } from "./types";

// Build the service lazily per isolate (Workers re-creates module scope on cold start).
// Each isolate instance reuses its own service for the lifetime of the isolate.
let llm: GuidlioLMService | null = null;

function getService(env: Env): GuidlioLMService {
	if (llm) return llm;

	const registry = new PromptRegistry();
	registry.register({
		promptId: "summarize",
		version: 1,
		systemPrompt: "Summarize in at most three sentences.",
		userPrompt: "{text}",
		modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
		output: { type: "text" },
	});

	llm = new GuidlioLMService({
		providers: [new OpenAIProvider(env.OPENAI_API_KEY)],
		promptRegistry: registry,
		cacheProvider: new KVCacheProvider(env.LLM_CACHE),
	});
	return llm;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const body = await request.json() as { text?: string };
		if (!body.text?.trim()) {
			return Response.json({ error: "text is required" }, { status: 400 });
		}

		const service = getService(env);
		const traceId = request.headers.get("x-trace-id") ?? crypto.randomUUID();

		const result = await service.callText({
			promptId: "summarize",
			variables: { text: body.text },
			traceId,
			signal: request.signal,
			cache: { mode: "read_through", ttlSeconds: 3_600 },
		});

		return Response.json({ summary: result.text }, {
			headers: { "x-trace-id": result.traceId },
		});
	},
} satisfies ExportedHandler<Env>;
```

**`src/types.ts`:**
```typescript
import type { KVNamespace } from "@cloudflare/workers-types";

export interface Env {
	OPENAI_API_KEY: string;
	LLM_CACHE: KVNamespace;
}
```

---

## Known limitations

| Limitation | Workaround |
| :--- | :--- |
| `import { randomUUID } from "crypto"` requires Node.js compat | Set `compatibility_flags = ["nodejs_compat"]` in `wrangler.toml` |
| No persistent in-memory cache across requests (isolates are short-lived) | Use KV, Durable Objects, or an external Redis for caching |
| Worker CPU time limit (10–30 ms unbundled) | Use `ctx.waitUntil` for async cache writes that don't need to block the response |

---

## What to change next

- [custom-cache-redis.md](../../src/llm-service/examples/extensions/custom-cache-redis.md) — Redis-based cache for production environments with a persistent connection
- [aws-lambda.md](./aws-lambda.md) — Lambda patterns (deadline-derived AbortSignal, Secrets Manager)
