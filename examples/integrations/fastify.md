# Fastify Integration

Wiring `guidlio-lm` into a Fastify application using a plugin, Fastify's built-in request logger, and per-request traceId from `request.id`.

**Concepts covered:**
- Registering the LLM service as a Fastify plugin with `fastify.decorate`
- Adapting `LLMLogger` to Fastify's `pino` logger
- `request.id` as the per-request traceId
- AbortSignal from socket close
- Accessing the service via `request.server.llm`

---

## Logger adapter

Fastify uses `pino` internally. This adapter delegates to `request.log` (if available) or falls back to `fastify.log`.

```typescript
// src/llmLogger.ts
import type { FastifyBaseLogger } from "fastify";
import type { LLMLogger } from "guidlio-lm";

export class FastifyLLMLogger implements LLMLogger {
	constructor(private log: FastifyBaseLogger) {}

	info(message: string, meta?: Record<string, unknown>): void {
		this.log.info(meta ?? {}, message);
	}

	warn(message: string, meta?: Record<string, unknown>): void {
		this.log.warn(meta ?? {}, message);
	}

	error(message: string, meta?: Record<string, unknown>): void {
		this.log.error(meta ?? {}, message);
	}
}
```

---

## Plugin

```typescript
// src/plugins/llm.ts
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";
import { FastifyLLMLogger } from "../llmLogger";

declare module "fastify" {
	interface FastifyInstance {
		llm: GuidlioLMService;
	}
}

export default fp(async (fastify: FastifyInstance) => {
	const registry = new PromptRegistry();

	registry.register({
		promptId: "summarize",
		version: 1,
		systemPrompt: "Summarize the input in at most three sentences.",
		userPrompt: "{text}",
		modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
		output: { type: "text" },
	});

	const llm = new GuidlioLMService({
		providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
		promptRegistry: registry,
		logger: new FastifyLLMLogger(fastify.log),
	});

	fastify.decorate("llm", llm);
});
```

---

## Route handler

```typescript
// src/routes/summarize.ts
import type { FastifyInstance } from "fastify";
import { LLMTransientError, LLMPermanentError } from "guidlio-lm";

export async function summarizeRoutes(fastify: FastifyInstance): Promise<void> {
	fastify.post<{ Body: { text: string } }>("/summarize", async (request, reply) => {
		const { text } = request.body;
		if (!text?.trim()) {
			return reply.code(400).send({ error: "text is required" });
		}

		// request.id is Fastify's auto-assigned per-request ID — reuse it as traceId
		// so LLM log entries and Fastify access logs share the same correlation key
		const traceId = request.id;

		const controller = new AbortController();
		request.socket.on("close", () => controller.abort(new Error("client disconnected")));

		try {
			const result = await request.server.llm.callText({
				promptId: "summarize",
				variables: { text },
				traceId,
				signal: controller.signal,
			});

			reply.header("x-trace-id", result.traceId);
			return { summary: result.text, durationMs: result.durationMs };
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				// Client gone — Fastify will clean up the response
				return;
			}
			if (err instanceof LLMTransientError) {
				return reply.code(503).send({ error: "service temporarily unavailable" });
			}
			if (err instanceof LLMPermanentError) {
				request.log.error({ err }, "LLM permanent error");
				return reply.code(500).send({ error: "internal server error" });
			}
			throw err; // let Fastify's error handler deal with unexpected errors
		}
	});
}
```

---

## App entry point

```typescript
// src/app.ts
import Fastify from "fastify";
import llmPlugin from "./plugins/llm";
import { summarizeRoutes } from "./routes/summarize";

const fastify = Fastify({ logger: true });

fastify.register(llmPlugin);
fastify.register(summarizeRoutes, { prefix: "/api" });

fastify.listen({ port: 3000 }, (err) => {
	if (err) { fastify.log.error(err); process.exit(1); }
});
```

---

## What to change next

- [express.md](./express.md) — same patterns for Express
- [10-observability-and-cost.md](../../src/llm-service/examples/10-observability-and-cost.md) — structured log entry shape and cost aggregation
