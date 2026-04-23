# Retry Tuning

The retry system protects against transient provider failures (rate limits, 5xx errors) without adding latency to the happy path. The default settings are conservative; this guide shows how to adjust them for the two most common scenarios — resilient batch jobs and low-latency user-facing APIs.

**Concepts covered:**
- Default retry parameters and the backoff formula
- Setting `maxAttempts: 1` to disable retries and why you'd want to
- Aggressive retry config for resilient batch processing
- Fast-fail config for user-facing APIs
- Which error types are retried and which propagate immediately

---

## Default behavior

```typescript
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";

const registry = new PromptRegistry();

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	// These are the defaults — shown explicitly for clarity:
	maxAttempts: 3,          // 1 original attempt + up to 2 retries
	retryBaseDelayMs: 1000,  // starting delay for the first retry
	maxDelayMs: 30_000,      // cap on any single retry delay
	promptRegistry: registry,
});
```

**Backoff formula** for attempt `n` (zero-based retry index):

```
delay = min(retryBaseDelayMs × 2^n + rand(0, 1000), maxDelayMs)
```

With defaults:
- Retry 1 (n=0): `min(1000 × 1 + jitter, 30000)` ≈ 1–2 s
- Retry 2 (n=1): `min(1000 × 2 + jitter, 30000)` ≈ 2–3 s

The `rand(0, 1000)` jitter spreads concurrent retries so they do not all hit the provider at the same moment after a rate-limit window resets.

---

## Disabling retries entirely (`maxAttempts: 1`)

Set `maxAttempts: 1` when another system already owns the retry logic and you want the service to fail fast on the first error.

```typescript
// Inside a pipeline orchestrator — the orchestrator's RetryPolicy handles retries
const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	maxAttempts: 1, // no retries — let the orchestrator decide
	promptRegistry: registry,
});
```

Scenarios where `maxAttempts: 1` is the right choice:

1. **Orchestrator-managed retries** — `GuidlioOrchestrator` with `RetryPolicy` already retries at the pipeline level; double-retrying inside the service adds unnecessary delay.
2. **Idempotent batch jobs** — the job scheduler retries the whole item on failure; internal retries could cause duplicate side effects if the call partially succeeded.
3. **Streaming calls** — `callStream` already bypasses retries entirely regardless of `maxAttempts`. Reconnection on stream errors is the caller's responsibility.

---

## Aggressive retry for resilient batch processing

Long-running batch jobs can tolerate higher total latency in exchange for fewer permanent failures. Wide backoff windows also help absorb provider rate-limit windows (typically 1-minute resets).

```typescript
const batchLlm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	maxAttempts: 10,           // 1 original + 9 retries before giving up
	retryBaseDelayMs: 200,     // start with a short delay — escalates quickly
	maxDelayMs: 60_000,        // allow up to 60 s per retry on the worst retries
	promptRegistry: registry,
});

// With these settings, worst-case retry sequence (ms, approximate):
// 200 + jitter, 400 + jitter, 800 + jitter, 1600, 3200, 6400, 12800, 25600, 51200 (capped at 60000)
// Total worst-case wait before attempt 10: ~110 s
```

Pair aggressive retries with an `idempotencyKey` so cache-warm reruns do not call the provider again for items that already succeeded:

```typescript
for (const item of batchItems) {
	await batchLlm.callText({
		promptId: "process-item",
		variables: { content: item.content },
		idempotencyKey: `batch:${batchId}:item:${item.id}`,
		cache: { mode: "read_through", ttlSeconds: 86400 },
	});
}
```

---

## Fast-fail for user-facing APIs

Users notice latency. A single retry with a short base delay keeps the perceived failure rate low without adding more than ~400 ms of retry overhead in the worst case.

```typescript
const userFacingLlm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	maxAttempts: 2,        // 1 original + 1 retry
	retryBaseDelayMs: 200, // ~200–1200 ms before the single retry
	maxDelayMs: 2_000,     // never wait more than 2 s
	promptRegistry: registry,
});
```

If the single retry also fails, surface the error to the user promptly rather than making them wait for a third attempt.

---

## Which errors are retried

Only `LLMTransientError` enters the retry loop. All other error types propagate immediately to the caller regardless of `maxAttempts`.

| Error | Retried? | Typical cause |
| :--- | :--- | :--- |
| `LLMTransientError` | Yes | 429 rate-limit, 503 provider outage, network timeout |
| `LLMPermanentError` | No | 401 auth, 400 bad request, model not found |
| `LLMParseError` | No | Model returned prose instead of valid JSON |
| `LLMSchemaError` | No | Parsed JSON did not match the Zod schema |

```typescript
import {
	LLMTransientError,
	LLMPermanentError,
	LLMParseError,
	LLMSchemaError,
} from "guidlio-lm";

try {
	const result = await llm.callText({ promptId: "summarize", variables: { text } });
} catch (err) {
	if (err instanceof LLMTransientError) {
		// All maxAttempts exhausted — every attempt returned 429 or 5xx
		console.error(`Transient failure, status ${err.statusCode}`);
	} else if (err instanceof LLMPermanentError) {
		// Not retried — fix the API key or request parameters
		console.error(`Permanent failure: ${err.message}`);
	} else if (err instanceof LLMParseError) {
		// Not retried — prompt engineering issue, not a transient glitch
		console.error("Model did not return valid JSON:", err.rawOutput.slice(0, 200));
	} else if (err instanceof LLMSchemaError) {
		// Not retried — schema mismatch, update the Zod schema or the prompt
		console.error("Schema validation failed:", err.validationErrors);
	}
}
```

---

## What to change next

- [07-providers-and-errors.md](./07-providers-and-errors.md) — full error type reference and multi-provider setup
- [08-cancellation-and-timeouts.md](./08-cancellation-and-timeouts.md) — per-call `AbortSignal` deadlines that override the retry loop
