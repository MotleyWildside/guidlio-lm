# Example: Plan → Execute → Verify Agent (Self-Correcting Loop)

An agent that breaks a high-level goal into subtasks, executes them, then
evaluates whether the goal was actually achieved. If verification fails and
attempts remain, it replans with the failure context included — enabling
self-correction.

```
plan ──► execute ──► verify ──pass──► (stop, ok)
  ▲                    │
  └──── goto:plan ─────┘ fail + attempts < MAX
                       │
                       └── degrade ── (stop, ok, degraded) if attempts exhausted
```

**Concepts covered:**
- `GOTO` loop from policy `ok()` override based on context values
- `DEGRADE` transition: partial success — goal not fully achieved but no hard error
- `contextAdjustment` from the policy: modify context during a transition without
  touching any step
- `result.degraded.reason` surfaced on the final result
- Factory policy pattern for concurrent safety

---

## Context

```typescript
import { BaseContext } from 'guidlio-lm';

interface PlanContext extends BaseContext {
  goal: string;
  constraints?: string[];         // e.g. ["must be under 500 chars", "cite sources"]
  plan?: string[];                // list of subtask descriptions
  executionLog: string[];         // what was done (appended each execute round)
  verificationResult?: {
    passed: boolean;
    feedback: string;             // LLM's critique — fed back into next plan
  };
  planningAttempts: number;       // how many plan→execute→verify cycles we've run
}
```

---

## Policy

The routing logic lives entirely in the policy. Steps stay pure — they don't know
whether they'll loop or stop.

```typescript
import {
  DefaultPolicy,
  StepOutcomeOk,
  PolicyDecisionInput,
  PolicyDecisionOutput,
  Transition,
  ContextAdjustment,
} from 'guidlio-lm';

const MAX_PLANNING_ATTEMPTS = 3;

class PlanExecutePolicy extends DefaultPolicy<PlanContext> {
  protected override ok(
    outcome: StepOutcomeOk,
    input: PolicyDecisionInput<PlanContext>,
  ): Transition {
    // Only intercept the verify step — everything else continues linearly
    if (input.stepName !== 'verify') {
      return super.ok(outcome, input);
    }

    const ctx = input.stepResult.ctx;

    if (ctx.verificationResult?.passed) {
      return { type: 'stop' };
    }

    if (ctx.planningAttempts < MAX_PLANNING_ATTEMPTS) {
      // Loop back to plan. The orchestrator will call planningAttempts++ via
      // contextAdjustment so neither the step nor the context mutation lives
      // inside the step's run() method.
      return { type: 'goto', stepName: 'plan' };
    }

    // Out of attempts — degrade rather than hard-fail so the caller gets back
    // whatever partial work was done along with a human-readable reason.
    return {
      type: 'degrade',
      reason: `Goal not fully achieved after ${ctx.planningAttempts} planning attempt(s). Last feedback: ${ctx.verificationResult?.feedback ?? 'none'}`,
    };
  }

  // Use contextAdjustment to increment planningAttempts when looping back to plan.
  // This keeps the mutation out of the step and makes it explicit in the policy.
  override decide(input: PolicyDecisionInput<PlanContext>): PolicyDecisionOutput<PlanContext> {
    const base = super.decide(input);

    if (
      base.transition.type === 'goto' &&
      base.transition.stepName === 'plan'
    ) {
      const ctx = input.stepResult.ctx;
      const adjustment: ContextAdjustment<PlanContext> = {
        type: 'patch',
        patch: { planningAttempts: ctx.planningAttempts + 1 },
      };
      return { transition: base.transition, contextAdjustment: adjustment };
    }

    return base;
  }
}
```

---

## Steps

### `plan` — LLM generates a task list

```typescript
import { PipelineStep, StepResult, StepRunMeta, ok, failed } from 'guidlio-lm';

class PlanStep extends PipelineStep<PlanContext> {
  readonly name = 'plan';

  async run(ctx: PlanContext, meta: StepRunMeta): Promise<StepResult<PlanContext>> {
    // On replanning rounds, pass previous feedback so the LLM can correct course.
    const previousFeedback = ctx.verificationResult?.feedback;

    let plan: string[];
    try {
      plan = await llm.generatePlan({
        goal:             ctx.goal,
        constraints:      ctx.constraints,
        previousAttempts: ctx.executionLog,
        correctionHint:   previousFeedback,
        signal:           meta.signal,
      });
    } catch (err) {
      return failed({
        ctx,
        error: err instanceof Error ? err : new Error(String(err)),
        retryable: true,
      });
    }

    if (!plan.length) {
      return failed({ ctx, error: new Error('LLM returned an empty plan'), retryable: false });
    }

    // Clear the previous verification result so the next verify starts fresh
    return ok({ ctx: { ...ctx, plan, verificationResult: undefined } });
  }
}
```

### `execute` — Run each subtask

```typescript
class ExecuteStep extends PipelineStep<PlanContext> {
  readonly name = 'execute';

  async run(ctx: PlanContext, meta: StepRunMeta): Promise<StepResult<PlanContext>> {
    if (!ctx.plan?.length) {
      return failed({ ctx, error: new Error('No plan to execute'), retryable: false });
    }

    const newLog: string[] = [];
    for (const task of ctx.plan) {
      if (meta.signal?.aborted) {
        return failed({ ctx, error: new Error('Execution aborted'), retryable: false });
      }

      try {
        const result = await executor.runTask(task, meta.signal);
        newLog.push(`[OK] ${task}: ${result}`);
      } catch (err) {
        // Append the failure to the log — don't abort the whole loop.
        // The verify step will catch that this task didn't produce output.
        newLog.push(`[FAIL] ${task}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return ok({
      ctx: {
        ...ctx,
        executionLog: [...ctx.executionLog, ...newLog],
      },
    });
  }
}
```

### `verify` — LLM judges if the goal was achieved

```typescript
class VerifyStep extends PipelineStep<PlanContext> {
  readonly name = 'verify';

  async run(ctx: PlanContext, meta: StepRunMeta): Promise<StepResult<PlanContext>> {
    let verificationResult: PlanContext['verificationResult'];
    try {
      verificationResult = await llm.verify({
        goal:         ctx.goal,
        constraints:  ctx.constraints,
        executionLog: ctx.executionLog,
        signal:       meta.signal,
      });
    } catch (err) {
      return failed({
        ctx,
        error: err instanceof Error ? err : new Error(String(err)),
        retryable: true,
      });
    }

    // Always return ok — passed/failed is business data, not a pipeline error.
    // The policy decides what to do with verificationResult.passed.
    return ok({ ctx: { ...ctx, verificationResult } });
  }
}
```

---

## Wiring

```typescript
import { PipelineOrchestrator, LoggerPipelineObserver } from 'guidlio-lm';

const orchestrator = new PipelineOrchestrator<PlanContext>({
  steps: [
    new PlanStep(),
    new ExecuteStep(),
    new VerifyStep(),
  ],
  policy:   () => new PlanExecutePolicy(),
  observer: new LoggerPipelineObserver(),
  maxTransitions: 20, // 3 attempts × (plan+execute+verify) = 9 transitions, well within 20
});
```

---

## Running

```typescript
const result = await orchestrator.run({
  traceId:          'agent-pev-001',
  goal:             'Write a concise summary of the Q3 earnings report',
  constraints:      ['under 300 words', 'include revenue and key risks'],
  executionLog:     [],
  planningAttempts: 1,  // first attempt
});

if (result.status === 'ok') {
  if (result.degraded) {
    // Goal was not fully achieved but the agent did partial work
    console.warn('Partially achieved:', result.degraded.reason);
    console.log('Execution log:', result.ctx.executionLog);
  } else {
    console.log('Goal achieved!');
    console.log('Execution log:', result.ctx.executionLog);
  }
} else {
  console.error('Hard failure:', result.error.message);
}
```

---

## Flow traces

**First attempt passes:**
```
plan (attempt 1) → next
execute          → next
verify           → stop              ← verificationResult.passed === true
                                       status: ok
```

**First attempt fails, second succeeds:**
```
plan (attempt 1)  → next
execute           → next
verify            → goto:plan   +contextAdjustment: planningAttempts=2
plan (attempt 2)  → next
execute           → next
verify            → stop              ← passed on second round
                                        status: ok
```

**All attempts exhausted:**
```
plan (attempt 1)  → next
execute           → next
verify            → goto:plan   +contextAdjustment: planningAttempts=2
plan (attempt 2)  → next
execute           → next
verify            → goto:plan   +contextAdjustment: planningAttempts=3
plan (attempt 3)  → next
execute           → next
verify            → degrade           ← planningAttempts === MAX_PLANNING_ATTEMPTS
                                        status: ok, degraded: { reason: "..." }
```

---

## Why `DEGRADE` instead of `FAIL` on exhaustion?

`FAIL` signals that something broke unexpectedly — callers handle it as an error.
`DEGRADE` signals that the pipeline ran to completion but the goal was only
partially met — callers get the full context (including all the execution logs)
and can decide whether partial output is usable. Consumers check `result.degraded`
the same way they would check a "soft error" flag in an API response.

Use `FAIL` when the pipeline cannot meaningfully continue (auth error, bad input).
Use `DEGRADE` when the agent did real work and the result has value, even if it
didn't fully satisfy the goal.
