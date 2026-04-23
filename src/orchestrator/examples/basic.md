# Example: Basic Three-Step Pipeline

A minimal end-to-end example showing how to build, configure, and run a linear
pipeline with no custom policy.

**Steps:** `validate-user → fetch-profile → enrich-context`

**Concepts covered:**
- Extending `PipelineStep` with a typed context
- `ok()` and `failed()` helpers
- Default policy: `ok → next`, `failed → fail` (no subclassing needed)
- Checking `result.status`, `result.error.statusCode`, and `result.error.stepName`

---

## Context

```typescript
import { BaseContext } from 'guidlio-lm';

interface UserContext extends BaseContext {
  userId: string;
  profile?: { name: string; tier: 'free' | 'pro' };
  enriched?: boolean;
}
```

`BaseContext` guarantees `traceId: string`. Everything else is your domain data.

---

## Steps

```typescript
import { PipelineStep, StepResult, StepRunMeta, ok, failed } from 'guidlio-lm';

class ValidateUserStep extends PipelineStep<UserContext> {
  readonly name = 'validate-user';

  async run(ctx: UserContext, _meta: StepRunMeta): Promise<StepResult<UserContext>> {
    if (!ctx.userId.trim()) {
      // retryable: false — a bad userId won't get better on a second attempt
      return failed({ ctx, error: new Error('userId is required'), retryable: false });
    }
    return ok({ ctx });
  }
}

class FetchProfileStep extends PipelineStep<UserContext> {
  readonly name = 'fetch-profile';

  async run(ctx: UserContext, _meta: StepRunMeta): Promise<StepResult<UserContext>> {
    const profile = await db.findUser(ctx.userId);
    if (!profile) {
      return failed({
        ctx,
        error: new Error(`User "${ctx.userId}" not found`),
        retryable: false,
        statusCode: 404,
      });
    }
    // Return a new ctx object — never mutate the incoming ctx directly
    return ok({ ctx: { ...ctx, profile } });
  }
}

class EnrichContextStep extends PipelineStep<UserContext> {
  readonly name = 'enrich-context';

  async run(ctx: UserContext, _meta: StepRunMeta): Promise<StepResult<UserContext>> {
    // Feature flags, A/B cohort assignment, locale resolution, etc.
    return ok({ ctx: { ...ctx, enriched: true } });
  }
}
```

> **`_meta` is unused here** — in a purely linear pipeline with no retries you rarely
> need it. Later examples show where `meta.attempt` and `meta.signal` become essential.

---

## Wiring

```typescript
import { PipelineOrchestrator } from 'guidlio-lm';

const orchestrator = new PipelineOrchestrator<UserContext>({
  steps: [
    new ValidateUserStep(),
    new FetchProfileStep(),
    new EnrichContextStep(),
  ],
  // No policy or observer specified — defaults to NoopPipelineObserver and
  // DefaultPolicy (ok → next, failed → fail immediately).
});
```

---

## Running & reading results

```typescript
// Happy path
const result = await orchestrator.run({ traceId: 'req-abc', userId: 'user-42' });

if (result.status === 'ok') {
  console.log(result.ctx.profile);   // { name: 'Alice', tier: 'pro' }
  console.log(result.ctx.enriched);  // true
}

// Failure path — user not found
const miss = await orchestrator.run({ traceId: 'req-xyz', userId: 'ghost' });

if (miss.status === 'failed') {
  console.error(miss.error.message);    // User "ghost" not found
  console.error(miss.error.statusCode); // 404
  console.error(miss.error.stepName);   // fetch-profile
  // miss.error.cause is the original Error thrown (or returned) by the step
}
```

---

## What happens when a step throws?

If a step throws an unhandled exception instead of returning `failed()`, the
orchestrator catches it and converts it to `{ type: 'failed', retryable: false }`.
The `DefaultPolicy` then maps that to a `FAIL` transition, so the pipeline ends
with `status: 'failed'` just like an explicit `failed()` return — but the
`cause` on the resulting `StepExecutionError` holds the original thrown value.

```typescript
class BuggyStep extends PipelineStep<UserContext> {
  readonly name = 'buggy';
  async run(ctx: UserContext, _meta: StepRunMeta): Promise<StepResult<UserContext>> {
    throw new TypeError('Unexpected null'); // caught by the orchestrator
  }
}
// result.status === 'failed'
// result.error.cause instanceof TypeError  → true
// result.error.stepName                    → 'buggy'
```
