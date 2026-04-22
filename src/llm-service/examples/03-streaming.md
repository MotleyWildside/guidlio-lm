# Streaming

`callStream` returns a result immediately with a `stream` field you iterate with `for await`. The provider connection is established lazily — the network call happens on the first iteration, not at `callStream` time.

## Basic streaming to stdout

```typescript
import { LLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";

const registry = new PromptRegistry();

registry.register({
	promptId: "story",
	version: 1,
	userPrompt: "Write a short story about {topic}.",
	modelDefaults: { model: "gpt-4o-mini", maxTokens: 512 },
	output: { type: "text" },
});

const llm = new LLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});

const { stream, traceId } = await llm.callStream({
	promptId: "story",
	variables: { topic: "a robot learning to bake" },
});

for await (const chunk of stream) {
	process.stdout.write(chunk.delta); // incremental text since last chunk
}
// chunk.text is the full accumulated text up to that point
// chunk.delta is only the new characters in this chunk
```

## Streaming to an HTTP response (Node.js)

```typescript
import type { Response } from "express";

async function streamToClient(res: Response, topic: string) {
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");

	const { stream } = await llm.callStream({
		promptId: "story",
		variables: { topic },
	});

	try {
		for await (const chunk of stream) {
			res.write(`data: ${JSON.stringify({ delta: chunk.delta })}\n\n`);
		}
	} finally {
		res.end();
	}
}
```

## Cancelling a stream with AbortSignal

```typescript
const controller = new AbortController();

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5_000);

const { stream } = await llm.callStream({
	promptId: "story",
	variables: { topic: "a very long saga" },
	signal: controller.signal,
});

try {
	for await (const chunk of stream) {
		process.stdout.write(chunk.delta);
	}
} catch (err) {
	if ((err as Error).name === "AbortError") {
		console.log("\n[stream cancelled]");
	} else {
		throw err;
	}
}
```

## Important caveats

| Behaviour | Notes |
| :--- | :--- |
| **No retries** | `callStream` does not wrap the stream in `callWithRetries`. If the connection drops mid-stream, restart from the call site. |
| **No caching** | `cache` and `idempotencyKey` params are silently ignored with a warn-log. |
| **Error inside the iterator** | Errors thrown during iteration (network drop, provider error) surface as rejected iterations — wrap your `for await` in `try/catch`. |
| **`durationMs` unavailable** | The result object has no `durationMs` because the call completes asynchronously after the iterator is exhausted. Measure it yourself if needed. |
