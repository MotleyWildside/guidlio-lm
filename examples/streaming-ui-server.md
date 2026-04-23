# Streaming UI Server

Server-Sent Events (SSE) let the browser receive LLM output as it is generated, producing a responsive typing effect without polling. This recipe shows a production-ready Express route handler that pipes `callStream` deltas over SSE, handles client disconnection cleanly, and includes a Fastify variant.

**Concepts covered:**
- `callStream` with `AbortSignal` for cooperative cancellation
- SSE headers and `data:` frame format
- Client disconnect detection via `req.on("close", ...)`
- `res.writableEnded` guard before each write
- Fastify variant using `reply.raw` to access the Node.js `ServerResponse`
- Why `callStream` has no automatic retry and why the browser should reconnect

---

## Express handler

```typescript
import express, { Request, Response } from "express";
import {
	GuidlioLMService,
	OpenAIProvider,
	PromptRegistry,
	ConsoleLogger,
} from "guidlio-lm";

// Singleton — initialized once at module load, reused across requests
const registry = new PromptRegistry();

registry.register({
	promptId: "chat_reply",
	version: 1,
	systemPrompt: "You are a helpful assistant. Respond clearly and concisely.",
	userPrompt: "{message}",
	modelDefaults: { model: "gpt-4o-mini", maxTokens: 1024 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
	logger: new ConsoleLogger(),
});

const app = express();
app.use(express.json());

app.post("/api/chat/stream", async (req: Request, res: Response) => {
	const message = req.body?.message as string | undefined;
	if (!message) {
		res.status(400).json({ error: "message is required" });
		return;
	}

	const traceId = (req.headers["x-trace-id"] as string | undefined) ?? crypto.randomUUID();
	const controller = new AbortController();

	// Cancel the in-flight LLM call when the client disconnects
	req.on("close", () => controller.abort("client_disconnected"));

	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Trace-Id", traceId);
	// Prevent nginx/proxy from buffering the stream
	res.setHeader("X-Accel-Buffering", "no");
	res.flushHeaders();

	try {
		const { stream } = await llm.callStream({
			promptId: "chat_reply",
			variables: { message },
			traceId,
			signal: controller.signal,
		});

		for await (const chunk of stream) {
			// Guard: client may have disconnected while we were awaiting a chunk
			if (res.writableEnded) break;
			res.write(`data: ${JSON.stringify({ delta: chunk.delta })}\n\n`);
		}

		if (!res.writableEnded) {
			// Signal the browser that the stream is complete
			res.write("data: [DONE]\n\n");
			res.end();
		}
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			// Client disconnected — nothing to send
			return;
		}
		if (!res.writableEnded) {
			res.write(`data: ${JSON.stringify({ error: "Stream failed" })}\n\n`);
			res.end();
		}
	}
});

app.listen(3000, () => console.log("Listening on :3000"));
```

---

## Browser client

The browser uses `EventSource` to consume the SSE stream. Because `EventSource` reconnects automatically on error, a dropped stream will restart from scratch — acceptable for short completions, but for long generations you may want to track a `Last-Event-ID` offset.

```typescript
// In your frontend (TypeScript / browser)
const eventSource = new EventSource("/api/chat/stream"); // GET-only

// For POST with a body, use fetch with a ReadableStream reader instead:
async function streamChat(message: string): Promise<void> {
	const response = await fetch("/api/chat/stream", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message }),
	});

	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			const payload = line.slice(6).trim();
			if (payload === "[DONE]") return;
			const parsed = JSON.parse(payload) as { delta?: string; error?: string };
			if (parsed.delta) process.stdout.write(parsed.delta); // or update DOM
		}
	}
}
```

---

## Fastify variant

Fastify routes through its own reply abstraction, but you can access the raw Node.js `ServerResponse` via `reply.raw` for SSE.

```typescript
import Fastify from "fastify";
import type { FastifyRequest, FastifyReply } from "fastify";

const fastify = Fastify({ logger: true });

interface StreamBody {
	message: string;
}

fastify.post<{ Body: StreamBody }>("/api/chat/stream", async (request, reply) => {
	const { message } = request.body;
	const traceId = (request.headers["x-trace-id"] as string | undefined) ?? crypto.randomUUID();
	const controller = new AbortController();

	request.socket.on("close", () => controller.abort("client_disconnected"));

	// Bypass Fastify's serialization — write raw SSE frames
	reply.raw.setHeader("Content-Type", "text/event-stream");
	reply.raw.setHeader("Cache-Control", "no-cache");
	reply.raw.setHeader("Connection", "keep-alive");
	reply.raw.setHeader("X-Accel-Buffering", "no");
	reply.raw.flushHeaders?.();

	try {
		const { stream } = await llm.callStream({
			promptId: "chat_reply",
			variables: { message },
			traceId,
			signal: controller.signal,
		});

		for await (const chunk of stream) {
			if (reply.raw.writableEnded) break;
			reply.raw.write(`data: ${JSON.stringify({ delta: chunk.delta })}\n\n`);
		}

		if (!reply.raw.writableEnded) {
			reply.raw.write("data: [DONE]\n\n");
			reply.raw.end();
		}
	} catch (err) {
		if ((err as Error).name !== "AbortError" && !reply.raw.writableEnded) {
			reply.raw.write(`data: ${JSON.stringify({ error: "Stream failed" })}\n\n`);
			reply.raw.end();
		}
	}
});

await fastify.listen({ port: 3000 });
```

---

## The no-retry gotcha

`callStream` does not wrap the async iterator in retry logic. If the HTTP connection to the provider drops mid-stream, the `for await` loop throws. The SSE connection to the browser also closes. The browser's `EventSource` will reconnect, starting a brand-new LLM call. For most use cases this is acceptable. If you need resumable streams, store partial output to a database keyed by `traceId` and replay it on reconnect.

---

## What to change next

- [RAG pipeline](rag-pipeline.md) — stream the final generate step instead of returning a single text result
- [Next.js route handler](integrations/nextjs-route-handler.md) — the same pattern adapted for the App Router
