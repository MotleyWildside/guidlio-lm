# Pipeline Orchestrator

A minimal, type-safe, Finite State Machine (FSM) powered framework for running step-based pipelines. Designed for complex workflows where control flow needs to be dynamic based on step results.

## Core Concepts

The orchestrator separates **execution logic** (Steps) from **routing logic** (Policies).

### 1. PipelineStep
A step is a discrete unit of work. It takes a context and per-invocation metadata, and returns an `outcome`.
*   **Outcome**: Describes *what* happened semantically (e.g., `ok`, `failed`, `redirect`). It should not decide *where* to go next.
*   **Meta** (`StepRunMeta`): Carries `attempt` (1-based retry count), `previousOutcome` (last outcome for this step, on retries), and `signal` (the run's `AbortSignal` for cooperative cancellation).

### 2. PipelinePolicy
The policy is the "brain" of the pipeline. It looks at the outcome of the current step and decides the `transition`. `decide()` may be synchronous or `async`.
*   **Transition**: Describes *where* to go next (e.g., `next`, `goto`, `retry`, `stop`, `fail`, `degrade`).

### 3. PipelineOrchestrator
The engine that runs the loop. It manages the context, executes steps, consults the policy for transitions, and handles observability.

---

## Architecture Overview

```mermaid
graph TD
    Start((Start)) --> Step[Execute Step]
    Step --> Outcome{Step Outcome}
    Outcome --> Policy[Consult Policy]
    Policy --> Transition{Transition}
    
    Transition -- next --> Step
    Transition -- goto --> Step
    Transition -- retry --> Step
    Transition -- stop --> Finish((Success))
    Transition -- degrade --> Degraded((Degraded Success))
    Transition -- fail --> Failed((Failure))
```

---

## Implementation Guide

### Defining the Context
All pipelines must use a context that extends `BaseContext`.

```typescript
interface MyContext extends BaseContext {
  userId: string;
  data?: any;
  validationError?: string;
}
```

### Creating a Step
Extend the `PipelineStep` abstract class. Use status helpers like `ok()` and `failed()` for clean returns.
Use `meta.attempt` for retry-aware logic and `meta.signal` for cooperative cancellation.

```typescript
import { PipelineStep, StepResult, StepRunMeta, ok, failed } from './orchestrator';

class ValidateInputStep extends PipelineStep<MyContext> {
  readonly name = 'validate-input';

  async run(ctx: MyContext, meta: StepRunMeta): Promise<StepResult<MyContext>> {
    if (!ctx.userId) {
      return failed({ ctx, error: new Error('Missing User ID'), retryable: false });
    }
    return ok({ ctx });
  }
}
```

### Configuring the Pipeline
Assemble steps and optionally a custom policy or observer.

```typescript
import { PipelineOrchestrator, LoggerPipelineObserver } from './orchestrator';

const orchestrator = new PipelineOrchestrator<MyContext>({
  steps: [
    new ValidateInputStep(),
    new FetchDataStep(),
    new ProcessDataStep()
  ],
  observer: new LoggerPipelineObserver(),
  maxTransitions: 20, // guard against infinite loops
  stepTimeoutMs: 5000, // fail the step if it takes longer than 5 s
});

const result = await orchestrator.run({ userId: '123', traceId: '...' });

if (result.status === 'ok') {
  console.log('Finished!', result.ctx);
  if (result.degraded) console.warn('Degraded:', result.degraded.reason);
} else {
  console.error('Failed:', result.error.message);
}
```

#### Cancellation via AbortSignal

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 10_000); // cancel after 10 s

const result = await orchestrator.run(ctx, { signal: controller.signal });
```

---

## Transitions & Control Flow

| Transition | Action | Result Status |
| :--- | :--- | :--- |
| `next` | Moves to the next step in the `steps` array. | - |
| `goto` | Jumps to a specific step by name. | - |
| `retry` | Re-executes a step (defaults to current step). | - |
| `stop` | Terminates execution immediately. | `ok` |
| `degrade` | Terminates execution immediately (graceful failure). | `ok` (with `degraded: { reason }`) |
| `fail` | Terminates execution with an error. | `failed` |

---

## Advanced: Custom Policies
By default, `DefaultPolicy` handles `ok` → next and `failed` → fail.
`redirect` has no meaningful default — it is a routing signal that always requires
a custom policy. If a step emits `redirect` and no routing is configured, the
pipeline fails with a descriptive error pointing you to `override redirect()` or `decide()`.
Extend `DefaultPolicy` to map redirect outcomes to GOTO transitions.

```typescript
import { DefaultPolicy, StepOutcomeFailed, Transition, PolicyDecisionInput } from './orchestrator';

class RetryPolicy extends DefaultPolicy<MyContext> {
  private retryCounts = new Map<string, number>();

  protected override fail(outcome: StepOutcomeFailed, input: PolicyDecisionInput<MyContext>): Transition {
    const stepName = input.stepName;
    const attempts = this.retryCounts.get(stepName) ?? 0;

    if (outcome.retryable && attempts < 3) {
      this.retryCounts.set(stepName, attempts + 1);
      return { type: 'retry' };
    }

    return super.fail(outcome, input);
  }

  override reset() {
    this.retryCounts.clear();
  }
}
```

> **Concurrent runs**: pass a factory to `policy` so each run gets its own policy instance:
> ```typescript
> new PipelineOrchestrator({ policy: () => new RetryPolicy(), steps: [...] });
> ```
> Passing an instance directly is safe for sequential runs only.

---

## Observability
The `PipelineObserver` interface allows you to hook into every lifecycle event:
- `onRunStart` / `onRunFinish`
- `onStepStart` / `onStepFinish`
- `onTransition` *(optional)* — fired after the policy decides, before the transition is applied
- `onError`

Use `LoggerPipelineObserver` for structured logging, `NoopPipelineObserver` as a silent base class,
or implement your own to emit metrics.
