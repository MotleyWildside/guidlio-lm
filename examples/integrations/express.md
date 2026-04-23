# Express Integration

How to wire `guidlio-lm` into an Express application: a singleton service shared across requests, per-request trace IDs for log correlation, and AbortSignal wired to the HTTP connection lifecycle.

**Concepts covered:**
- Singleton `GuidlioLMService` at module level
- Per-request `traceId` from an incoming header or auto-generated
- `AbortController` tied to `req.on("close")` for client-disconnect cancellation
- Error mapping to HTTP status codes

---

## Service singleton

Initialize the service once at module load. Providers are stateless and the `InMemoryCacheProvider` is process-local — both are safe to share across requests.

```typescript
// src/llm.ts
import { GuidlioLMService, OpenAIProvider, PromptRegistry, ConsoleLogger } from "guidlio-lm";

const registry = new PromptRegistry();

registry.register({
	promptId: "summarize",
	version: 1,
	systemPrompt: "Summarize the input in at most three sentences.",
	userPrompt: "{text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
	output: { type: "text" },
});

export const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
	logger: new ConsoleLogger(),
	maxAttempts: 3,
});
```

---

## Route handler

```typescript
// src/routes/summarize.ts
import { Router } from "express";
import { llm } from "../llm";
import { LLMTransientError, LLMPermanentError, LLMParseError, LLMSchemaError } from "guidlio-lm";

export const router = Router();

router.post("/summarize", async (req, res) => {
	const text = req.body?.text as string | undefined;
	if (!text?.trim()) {
		res.status(400).json({ error: "text is required" });
		return;
	}

	// Use the caller's trace ID when provided so logs correlate across services.
	// Fall back to a fresh UUID if the header is absent.
	const traceId = (req.headers["x-trace-id"] as string | undefined) ?? crypto.randomUUID();

	// Cancel the LLM call if the HTTP client disconnects before we respond.
	const controller = new AbortController();
	req.on("close", () => controller.abort(new Error("client disconnected")));

	try {
		const result = await llm.callText({
			promptId: "summarize",
			variables: { text },
			traceId,
			signal: controller.signal,
		});

		res.setHeader("x-trace-id", result.traceId);
		res.json({ summary: result.text, durationMs: result.durationMs });
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			// Client already gone — nothing to send
			return;
		}
		if (err instanceof LLMTransientError) {
			res.status(503).json({ error: "upstream service temporarily unavailable" });
		} else if (err instanceof LLMPermanentError) {
			res.status(500).json({ error: "LLM configuration error" });
		} else if (err instanceof LLMParseError || err instanceof LLMSchemaError) {
			res.status(502).json({ error: "unexpected response from LLM" });
		} else {
			res.status(500).json({ error: "internal server error" });
		}
	}
});
```

---

## App setup

```typescript
// src/app.ts
import express from "express";
import { router } from "./routes/summarize";

const app = express();
app.use(express.json());
app.use("/api", router);

app.listen(3000, () => console.log("Listening on :3000"));
```

---

## What to change next

- [01-basic-text.md](../../src/llm-service/examples/01-basic-text.md) — traceId propagation and per-call overrides
- [streaming-ui-server.md](../streaming-ui-server.md) — SSE streaming from an Express handler
