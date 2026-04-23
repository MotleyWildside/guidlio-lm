# Cancellation and Timeouts

`AbortSignal` lets you cancel an in-flight LLM call without waiting for the provider to respond. This is essential in server environments where a client can disconnect mid-request, and in batch jobs where you want a per-item deadline so a slow call does not stall the whole batch.

**Concepts covered:**
- Request-scoped cancellation: one `AbortController` per call
- Sharing a single signal across parallel calls with `Promise.all`
- Wrapping a call with a `setTimeout`-based deadline and cleaning up on success
- `AbortSignal.timeout(ms)` as a Node 17.3+ shorthand
- Why aborted calls are not retried
- Catching `AbortError` at the call site

---

## Request-scoped cancellation

Create one `AbortController` per request. Pass `.signal` to `callText`. When the caller wants to cancel — a client disconnect, a user clicking "stop" — call `controller.abort()`.

```typescript
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";

const registry = new PromptRegistry();

registry.register({
	promptId: "summarize",
	version: 1,
	systemPrompt: "You are a concise summarizer.",
	userPrompt: "Summarize: {text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});

const controller = new AbortController();

// In an HTTP handler, abort when the client disconnects
req.on("close", () => controller.abort());

try {
	const result = await llm.callText({
		promptId: "summarize",
		variables: { text: longArticle },
		signal: controller.signal,
	});
	res.json({ text: result.text });
} catch (err) {
	if (err instanceof Error && err.name === "AbortError") {
		// Client disconnected — no need to respond
		return;
	}
	throw err;
}
```

---

## Sharing one signal across parallel calls

Pass the same signal to every call in a `Promise.all`. When you abort, all in-flight calls are cancelled simultaneously.

```typescript
const controller = new AbortController();

// If either call is still running when the client disconnects, both are cancelled
req.on("close", () => controller.abort());

try {
	const [summary, tags] = await Promise.all([
		llm.callText({
			promptId: "summarize",
			variables: { text },
			signal: controller.signal,
		}),
		llm.callJSON({
			promptId: "extract-tags",
			variables: { text },
			signal: controller.signal,
		}),
	]);
	res.json({ summary: summary.text, tags: tags.data });
} catch (err) {
	if (err instanceof Error && err.name === "AbortError") {
		return;
	}
	throw err;
}
```

---

## setTimeout-based deadline

For a hard per-call time budget, create a controller, set a `setTimeout` to abort it, and clear the timer on success so it does not fire after the promise settles.

```typescript
async function callWithDeadline(text: string): Promise<string> {
	const controller = new AbortController();

	// Abort after 5 seconds regardless of provider response time
	const timer = setTimeout(() => controller.abort("timeout"), 5_000);

	try {
		const result = await llm.callText({
			promptId: "summarize",
			variables: { text },
			signal: controller.signal,
		});
		// Prevent the timer from firing after the call succeeds
		clearTimeout(timer);
		return result.text;
	} catch (err) {
		clearTimeout(timer);
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error("LLM call timed out after 5 s");
		}
		throw err;
	}
}
```

---

## AbortSignal.timeout (Node 17.3+ shorthand)

`AbortSignal.timeout(ms)` creates a signal that automatically fires after the given duration. It avoids the manual `setTimeout`/`clearTimeout` dance.

```typescript
// Equivalent to the manual deadline above, but with no timer to manage
try {
	const result = await llm.callText({
		promptId: "summarize",
		variables: { text },
		signal: AbortSignal.timeout(5_000),
	});
	return result.text;
} catch (err) {
	if (err instanceof Error && err.name === "TimeoutError") {
		// AbortSignal.timeout throws a TimeoutError (not AbortError) in Node >=17.3
		throw new Error("LLM call timed out after 5 s");
	}
	throw err;
}
```

> Note: `AbortSignal.timeout` raises a `TimeoutError` (error name `"TimeoutError"`), while a manually-aborted controller raises `"AbortError"`. Check both names if you mix the two approaches.

---

## Why aborted calls are not retried

Internally, when the provider SDK throws an abort-like error, the retry loop checks `error.name === "AbortError"` (or `"TimeoutError"`) and propagates immediately — it does not count as a transient failure and will not consume retry attempts. This means you never have to worry about a cancelled call silently retrying after the caller has already moved on.

The rule is: only `LLMTransientError` (provider 429s, 5xx responses) triggers the exponential-backoff retry loop. Abort is a deliberate cancellation, not a recoverable failure.

---

## What to change next

- [09-idempotency-and-cache-keys.md](./09-idempotency-and-cache-keys.md) — combine a deadline signal with an `idempotencyKey` so a retried webhook still hits the cache even if the first attempt was cancelled
- [11-retry-tuning.md](./11-retry-tuning.md) — tune `maxAttempts` and backoff delays, and understand when to set `maxAttempts: 1` to skip retries entirely
