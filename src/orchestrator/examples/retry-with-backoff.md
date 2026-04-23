# Example: Retry with Exponential Back-off

A pipeline that calls a flaky external API. Transient failures (503, rate-limit)
are retried up to three times with doubling delay. Permanent failures (400, auth)
propagate immediately.

**Steps:** `call-external-api → parse-response`

**Concepts covered:**
- `RetryPolicy` — drop-in retries with configurable back-off, no boilerplate
- `meta.attempt` — retry count visible inside the step for logging / jitter
- `retryable: true/false` — step signals intent; `RetryPolicy` enforces the limit
- `stepTimeoutMs` — hard wall-clock cap that races against the step's Promise
- `AbortSignal` — graceful pipeline cancellation from the caller

---

## Context

```typescript
import { BaseContext } from 'guidlio-lm';

interface ApiContext extends BaseContext {
  requestPayload: Record<string, unknown>;
  responseData?: unknown;
  parsedResult?: { score: number };
}
```

---

## Steps

```typescript
import { PipelineStep, StepResult, StepRunMeta, ok, failed } from 'guidlio-lm';

class CallExternalApiStep extends PipelineStep<ApiContext> {
  readonly name = 'call-external-api';

  async run(ctx: ApiContext, meta: StepRunMeta): Promise<StepResult<ApiContext>> {
    // Honor the AbortSignal forwarded from orchestrator.run(ctx, { signal })
    if (meta.signal?.aborted) {
      return failed({ ctx, error: new Error('Aborted before request'), retryable: false });
    }

    try {
      // meta.attempt is 1-based and increments on each RETRY transition.
      // Use it for logging, jitter, or choosing a fallback endpoint.
      console.log(`[call-external-api] attempt ${meta.attempt}`);
      const data = await externalApi(ctx.requestPayload, meta.signal);
      return ok({ ctx: { ...ctx, responseData: data } });
    } catch (err) {
      const isTransient = err instanceof TransientError; // 503, rate-limit
      return failed({
        ctx,
        error: err instanceof Error ? err : new Error(String(err)),
        // Signal intent — RetryPolicy only retries when retryable === true
        retryable: isTransient,
        statusCode: isTransient ? 503 : 400,
      });
    }
  }
}

class ParseResponseStep extends PipelineStep<ApiContext> {
  readonly name = 'parse-response';

  async run(ctx: ApiContext, _meta: StepRunMeta): Promise<StepResult<ApiContext>> {
    const raw = ctx.responseData as { score?: number };
    if (typeof raw?.score !== 'number') {
      return failed({ ctx, error: new Error('Invalid response: missing score'), retryable: false });
    }
    return ok({ ctx: { ...ctx, parsedResult: { score: raw.score } } });
  }
}
```

---

## Wiring

```typescript
import { PipelineOrchestrator, RetryPolicy } from 'guidlio-lm';

const orchestrator = new PipelineOrchestrator<ApiContext>({
  steps: [new CallExternalApiStep(), new ParseResponseStep()],

  // RetryPolicy options — all optional, shown here with their defaults:
  policy: () => new RetryPolicy({
    maxAttempts: 3,                                                  // first attempt + 2 retries
    retryIf: (outcome) => outcome.retryable === true,               // default — honour the step's flag
    backoffMs: (attempt) => Math.min(100 * 2 ** (attempt - 1), 30_000), // default — exponential
  }),

  // Fail the step (non-retryable) if it takes longer than 3 s.
  // Note: the step's Promise keeps running in the background — pass
  // meta.signal into your async work for true cooperative cancellation.
  stepTimeoutMs: 3_000,
});
```

The `delayMs` from `backoffMs` is passed on the `retry` transition and slept
inside the orchestrator — the step itself needs no backoff logic.

---

## Running

```typescript
// Normal run — will retry on transient failures
const result = await orchestrator.run({
  traceId: 'req-001',
  requestPayload: { query: 'hello' },
});

if (result.status === 'ok') {
  console.log('Score:', result.ctx.parsedResult?.score);
} else {
  console.error('Failed after retries:', result.error.message);
  // result.error.cause is the original Error from the step
}

// Cancellation from the caller side — also aborts any in-progress retry delay
const controller = new AbortController();
setTimeout(() => controller.abort('request_timeout'), 5_000);

const cancelled = await orchestrator.run(
  { traceId: 'req-002', requestPayload: { query: 'slow' } },
  { signal: controller.signal },
);
// cancelled.status === 'failed'
// cancelled.error instanceof PipelineAbortedError  → true
// cancelled.error.statusCode                        → 499
```

---

## How `stepTimeoutMs` interacts with retries

When the timeout fires the step result is `{ type: 'failed', retryable: false }`.
`RetryPolicy` therefore does **not** retry a timed-out step. If you want timed-out
steps to be retryable, pass a custom `retryIf` that checks the error message, or
use `meta.signal` inside the step so it can self-cancel and return an explicit
`retryable: true` result.

## Extending `RetryPolicy`

For retry logic that also needs routing (`failed` → GOTO a compensation step) or
mixed retry + redirect handling, subclass `RetryPolicy` rather than `DefaultPolicy`:

```typescript
class RetryThenFallbackPolicy extends RetryPolicy<ApiContext> {
  protected override fail(outcome: StepOutcomeFailed, input: PolicyDecisionInput<ApiContext>): Transition {
    const retry = super.fail(outcome, input);
    // If RetryPolicy decided to give up, redirect to the fallback step instead
    if (retry.type === 'fail') {
      return { type: 'goto', stepName: 'fallback' };
    }
    return retry;
  }
}
```
