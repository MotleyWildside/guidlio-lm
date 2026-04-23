# Example: FSM Routing with GOTO

A content-moderation pipeline that classifies text and routes it through different
processing branches depending on the classification result.

```
classify ──► safe    ──goto──► fast-approve ──► finalize
         ├─► review  ──goto──► full-review  ──► finalize
         └─► reject  ──goto──► reject-item  ──► finalize
```

**Concepts covered:**
- `redirect` outcome: a step signals *what* happened without deciding *where* to go
- `RedirectRoutingPolicy` — maps `outcome.message` to step names, no boilerplate
- `GOTO` transition: jump to any named step at runtime
- `onTransition` observer hook: surface every routing decision for debugging
- `NoopPipelineObserver` as a selective base class

---

## Context

```typescript
import { BaseContext } from 'guidlio-lm';

type Classification = 'safe' | 'review' | 'reject';

interface ModerationContext extends BaseContext {
  text: string;
  classification?: Classification;
  approved?: boolean;
  rejectionReason?: string;
}
```

---

## Observer — log every routing decision

```typescript
import { NoopPipelineObserver, PipelineObserver } from 'guidlio-lm';

class TransitionLogger extends NoopPipelineObserver implements PipelineObserver {
  onTransition(params: {
    traceId: string;
    stepName: string;
    transition: { type: string; stepName?: string; reason?: string };
  }): void {
    const dest =
      params.transition.stepName ? ` → ${params.transition.stepName}` :
      params.transition.reason   ? ` (${params.transition.reason})`   : '';

    console.log(`[${params.traceId.slice(-6)}] ${params.stepName}: ${params.transition.type}${dest}`);
  }
}
```

`NoopPipelineObserver` no-ops every required interface method, so you only
override the hooks you care about.

---

## Steps

```typescript
import { PipelineStep, StepResult, StepRunMeta, ok, failed, redirect } from 'guidlio-lm';

class ClassifyStep extends PipelineStep<ModerationContext> {
  readonly name = 'classify';

  async run(ctx: ModerationContext, _meta: StepRunMeta): Promise<StepResult<ModerationContext>> {
    const classification = await classifier.classify(ctx.text);
    // The step doesn't know step names — it signals WHAT happened.
    // RedirectRoutingPolicy maps the message to the correct GOTO target.
    return redirect({ ctx: { ...ctx, classification }, message: classification });
  }
}

class FastApproveStep extends PipelineStep<ModerationContext> {
  readonly name = 'fast-approve';

  async run(ctx: ModerationContext, _meta: StepRunMeta): Promise<StepResult<ModerationContext>> {
    return ok({ ctx: { ...ctx, approved: true } });
  }
}

class FullReviewStep extends PipelineStep<ModerationContext> {
  readonly name = 'full-review';

  async run(ctx: ModerationContext, _meta: StepRunMeta): Promise<StepResult<ModerationContext>> {
    const passed = await humanReview.evaluate(ctx.text);
    if (!passed) {
      return failed({
        ctx: { ...ctx, rejectionReason: 'Failed human review' },
        error: new Error('Content rejected after full review'),
        retryable: false,
        statusCode: 422,
      });
    }
    return ok({ ctx: { ...ctx, approved: true } });
  }
}

class RejectItemStep extends PipelineStep<ModerationContext> {
  readonly name = 'reject-item';

  async run(ctx: ModerationContext, _meta: StepRunMeta): Promise<StepResult<ModerationContext>> {
    // Return ok — rejection is a valid business outcome, not a pipeline error.
    return ok({ ctx: { ...ctx, approved: false, rejectionReason: 'Classified as reject' } });
  }
}

class FinalizeStep extends PipelineStep<ModerationContext> {
  readonly name = 'finalize';

  async run(ctx: ModerationContext, _meta: StepRunMeta): Promise<StepResult<ModerationContext>> {
    await auditLog.record(ctx);
    return ok({ ctx });
  }
}
```

---

## Wiring

```typescript
import { PipelineOrchestrator, RedirectRoutingPolicy } from 'guidlio-lm';

const orchestrator = new PipelineOrchestrator<ModerationContext>({
  steps: [
    new ClassifyStep(),
    // All possible routing targets must be registered even though only one
    // branch executes per run. GOTO validates the target name at transition
    // time and throws PipelineDefinitionError if it isn't found.
    new FastApproveStep(),
    new FullReviewStep(),
    new RejectItemStep(),
    new FinalizeStep(),
  ],
  policy: () => new RedirectRoutingPolicy({
    safe:   'fast-approve',
    review: 'full-review',
    reject: 'reject-item',
  }),
  observer: new TransitionLogger(),
  maxTransitions: 10,
});
```

---

## Running

```typescript
const safe = await orchestrator.run({ traceId: 'mod-001', text: 'A great post!' });
// [mod-001] classify:     goto → fast-approve
// [mod-001] fast-approve: next
// [mod-001] finalize:     next
// safe.status === 'ok', safe.ctx.approved === true

const review = await orchestrator.run({ traceId: 'mod-002', text: 'Borderline content' });
// [mod-002] classify:    goto → full-review
// [mod-002] full-review: next  (or failed if human review rejects it)

const spam = await orchestrator.run({ traceId: 'mod-003', text: 'Buy cheap pills now!' });
// [mod-003] classify:    goto → reject-item
// [mod-003] reject-item: next
// [mod-003] finalize:    next
// spam.status === 'ok', spam.ctx.approved === false
```

---

## Async routing

If your route table lives in a remote config store or depends on context values,
extend `DefaultPolicy` directly and override `decide()`:

```typescript
class AsyncModerationPolicy extends DefaultPolicy<ModerationContext> {
  override async decide(
    input: PolicyDecisionInput<ModerationContext>,
  ): Promise<PolicyDecisionOutput<ModerationContext>> {
    if (input.stepResult.outcome.type !== 'redirect') return super.decide(input);

    const target = await featureFlags.getRoute(
      input.stepName,
      input.stepResult.ctx.classification,
    );
    return { transition: { type: 'goto', stepName: target } };
  }
}
```
