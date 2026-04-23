# Next.js App Router Route Handler

Wiring `guidlio-lm` into a Next.js 13+ App Router route handler, including streaming responses via `ReadableStream` and correct singleton initialization.

**Concepts covered:**
- Singleton service initialized outside the handler for warm-instance reuse
- Streaming response with `TransformStream` and `ReadableStream`
- `request.signal` for client-disconnect cancellation (Next.js 13.2+)
- `guidlio-lm` cache vs. Next.js `fetch` cache — they are independent

---

## Singleton service

Initialize outside the handler so the instance (and its in-memory cache) survives across warm invocations in a long-lived server process.

```typescript
// lib/llm.ts
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";

const registry = new PromptRegistry();

registry.register({
	promptId: "summarize",
	version: 1,
	systemPrompt: "Summarize the input in at most three sentences.",
	userPrompt: "{text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
	output: { type: "text" },
});

registry.register({
	promptId: "story",
	version: 1,
	userPrompt: "Write a short story about {topic}.",
	modelDefaults: { model: "gpt-4o-mini", maxTokens: 512 },
	output: { type: "text" },
});

export const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});
```

---

## Non-streaming route handler

```typescript
// app/api/summarize/route.ts
import { NextRequest, NextResponse } from "next/server";
import { llm } from "@/lib/llm";
import { LLMTransientError } from "guidlio-lm";

export async function POST(request: NextRequest): Promise<NextResponse> {
	const body = await request.json() as { text?: string };
	if (!body.text?.trim()) {
		return NextResponse.json({ error: "text is required" }, { status: 400 });
	}

	try {
		const result = await llm.callText({
			promptId: "summarize",
			variables: { text: body.text },
			signal: request.signal, // Next.js 13.2+ provides signal tied to the request lifecycle
		});

		return NextResponse.json({ summary: result.text });
	} catch (err) {
		if (err instanceof LLMTransientError) {
			return NextResponse.json({ error: "service temporarily unavailable" }, { status: 503 });
		}
		return NextResponse.json({ error: "internal server error" }, { status: 500 });
	}
}
```

---

## Streaming route handler

Pipe `callStream` deltas over a `ReadableStream` response. The client receives incremental text as it is generated.

```typescript
// app/api/story/route.ts
import { NextRequest } from "next/server";
import { llm } from "@/lib/llm";

export async function POST(request: NextRequest): Promise<Response> {
	const body = await request.json() as { topic?: string };
	if (!body.topic?.trim()) {
		return new Response(JSON.stringify({ error: "topic is required" }), { status: 400 });
	}

	const { readable, writable } = new TransformStream<string, string>();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();

	// Start streaming in a detached async task so we can return the Response immediately.
	// The stream stays open until the generator exhausts or request.signal fires.
	(async () => {
		try {
			const { stream } = await llm.callStream({
				promptId: "story",
				variables: { topic: body.topic! },
				signal: request.signal,
			});

			for await (const chunk of stream) {
				if (request.signal.aborted) break;
				await writer.write(encoder.encode(chunk.delta));
			}
		} catch (err) {
			if ((err as Error).name !== "AbortError") {
				// Write an error marker so the client knows the stream broke
				await writer.write(encoder.encode("\n[error: stream interrupted]\n"));
			}
		} finally {
			await writer.close();
		}
	})();

	return new Response(readable, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Transfer-Encoding": "chunked",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
```

---

## Cache interaction

`guidlio-lm`'s cache and Next.js's built-in `fetch` cache are completely independent layers:

| Layer | Controlled by |
| :--- | :--- |
| `guidlio-lm` `InMemoryCacheProvider` | `cache: { mode, ttlSeconds }` on each call |
| Next.js `fetch` cache / `revalidate` | `export const revalidate = ...` in route segments |

Do not set `revalidate` on a route handler whose freshness is controlled by the LLM cache — the two caches will fight. Either use one or the other, or use `export const dynamic = "force-dynamic"` to opt the route out of Next.js caching entirely.

---

## What to change next

- [03-streaming.md](../../src/llm-service/examples/03-streaming.md) — streaming basics and the no-retry caveat
- [streaming-ui-server.md](../streaming-ui-server.md) — SSE streaming with Express/Fastify and client reconnect
