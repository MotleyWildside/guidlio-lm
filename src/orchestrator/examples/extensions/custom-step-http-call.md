# Example: Step That Wraps an HTTP Call

A step that calls an external HTTP API must translate HTTP status codes and network
errors into `StepOutcome` semantics. This example applies the same translation
discipline as the LLM step example: the step classifies error modes, returns the
appropriate `failed()` with a `retryable` flag, and the policy handles the retry
budget. The policy never needs to know what a 429 means.

**Concepts covered:**
- Passing `meta.signal` to `fetch()` for cooperative cancellation
- Translating 429 / 503 → `failed({ retryable: true, statusCode })`
- Translating 400 / 401 / 404 → `failed({ retryable: false, statusCode })`
- Catching network errors (ECONNRESET, abort, timeout) → `failed({ retryable: true })`
- Storing enriched data in ctx, returning `ok()`
- The key principle: steps classify failure modes; policies decide what to do about them

---

## Context

```typescript
import { BaseContext } from "guidlio-lm";

interface EnrichContext extends BaseContext {
	userId: string;
	profile?: {
		displayName: string;
		country: string;
		tier: "free" | "pro" | "enterprise";
	};
}
```

---

## Step

```typescript
import { PipelineStep, StepResult, StepRunMeta, ok, failed } from "guidlio-lm";

class EnrichStep extends PipelineStep<EnrichContext> {
	readonly name = "enrich";

	private readonly baseUrl: string;

	constructor(baseUrl: string) {
		super();
		this.baseUrl = baseUrl;
	}

	async run(ctx: EnrichContext, meta: StepRunMeta): Promise<StepResult<EnrichContext>> {
		let res: Response;

		try {
			res = await fetch(`${this.baseUrl}/users/${ctx.userId}/profile`, {
				headers: { "Accept": "application/json" },
				// Forward the orchestrator's AbortSignal — if the pipeline is cancelled,
				// the in-flight HTTP request is also cancelled
				signal: meta.signal,
			});
		} catch (err) {
			// fetch() throws on network errors: ECONNRESET, DNS failure,
			// AbortError (signal fired), or a Node.js timeout
			const isAbort = err instanceof Error && err.name === "AbortError";
			return failed({
				ctx,
				error: err instanceof Error ? err : new Error(String(err)),
				// Abort errors come from the caller's signal — not a transient issue,
				// the orchestrator will handle PipelineAbortedError separately
				retryable: !isAbort,
			});
		}

		if (res.ok) {
			// 2xx — parse and store the result
			const profile = (await res.json()) as EnrichContext["profile"];
			return ok({ ctx: { ...ctx, profile } });
		}

		// Classify the HTTP error
		if (res.status === 429 || res.status === 503) {
			// Rate-limited or service temporarily unavailable — worth retrying
			return failed({
				ctx,
				error: new Error(`Enrichment API returned ${res.status}`),
				retryable: true,
				statusCode: res.status,
			});
		}

		if (res.status === 400 || res.status === 401 || res.status === 404) {
			// Bad input, authentication failure, or user not found — retrying won't help
			return failed({
				ctx,
				error: new Error(`Enrichment API returned ${res.status}`),
				retryable: false,
				statusCode: res.status,
			});
		}

		// Unexpected status (500, 502, etc.) — treat as transient
		return failed({
			ctx,
			error: new Error(`Enrichment API returned unexpected status ${res.status}`),
			retryable: true,
			statusCode: res.status,
		});
	}
}
```

---

## Wiring

```typescript
import { GuidlioOrchestrator, RetryPolicy } from "guidlio-lm";

class UseProfileStep extends PipelineStep<EnrichContext> {
	readonly name = "use-profile";
	async run(ctx: EnrichContext, _meta: StepRunMeta): Promise<StepResult<EnrichContext>> {
		console.log("User tier:", ctx.profile?.tier);
		return ok({ ctx });
	}
}

const orchestrator = new GuidlioOrchestrator<EnrichContext>({
	steps: [
		new EnrichStep("https://api.example.com"),
		new UseProfileStep(),
	],
	policy: () => new RetryPolicy({
		maxAttempts: 3,
		// Only retry when the step flagged the failure as transient
		retryIf: (outcome) => outcome.retryable === true,
		backoffMs: (attempt) => 300 * 2 ** (attempt - 1),
	}),
	stepTimeoutMs: 10_000,
});
```

---

## Running

```typescript
const result = await orchestrator.run({ traceId: "enrich-001", userId: "user-99" });

if (result.status === "ok") {
	console.log("Profile:", result.ctx.profile);
} else {
	console.error("Enrichment failed:", result.error.message);
	console.error("Status code:", result.error.statusCode); // e.g. 404
	console.error("Step:", result.error.stepName);          // "enrich"
}
```

---

## Status code classification table

| HTTP status | `retryable` | Rationale |
|---|---|---|
| 200–299 | — | `ok()` returned |
| 429 | `true` | Rate-limited — back off and retry |
| 503 | `true` | Service unavailable — transient |
| 400 | `false` | Bad request — same input will fail again |
| 401 | `false` | Auth error — retry won't fix credentials |
| 404 | `false` | Resource not found — won't appear on retry |
| 500, 502, … | `true` | Unexpected server error — often transient |

Adjust this table to match the contract of your specific API. Some APIs use 503
for permanent shutdowns and 429 for true rate limits — check the docs.

---

## Retry-After header

If the API returns a `Retry-After` header, read it in the step and surface it via
a context field so a custom policy can use it for `delayMs`:

```typescript
if (res.status === 429) {
	const retryAfter = Number(res.headers.get("Retry-After") ?? "1") * 1000;
	return failed({
		ctx: { ...ctx, retryAfterMs: retryAfter }, // store on ctx for the policy to read
		error: new Error("Rate limited"),
		retryable: true,
		statusCode: 429,
	});
}
```

A custom policy can then return `{ type: "retry", delayMs: input.stepResult.ctx.retryAfterMs }`.

---

## What to change next

- Apply the same pattern to LLM calls: `./custom-step-llm-call.md`
- Fan out multiple HTTP calls in parallel inside a single step: `./custom-step-parallel-fanout.md`
