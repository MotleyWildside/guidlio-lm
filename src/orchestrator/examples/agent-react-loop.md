# Example: ReAct Agent Loop (Reason → Act → Observe)

The [ReAct pattern](https://arxiv.org/abs/2210.03629) interleaves *reasoning* (LLM
decides what to do next) with *acting* (execute a tool). The pipeline loops until
the LLM signals it has enough information to produce a final answer.

```
think ──redirect:use_tool──► act ──redirect:think──► think  (loop)
      └─redirect:answer────►                         answer ──► (done)
```

**Concepts covered:**
- `redirect` outcome as a routing signal from a step that doesn't know step names
- `RedirectRoutingPolicy` — maps `outcome.message` to GOTO targets, no boilerplate
- `maxTransitions` as the hard safety guard against infinite tool-call loops
- `meta.attempt` to detect if the LLM is looping without progress
- Accumulating an observable scratchpad in context across loop iterations

---

## Context

```typescript
import { BaseContext } from 'guidlio-lm';

type ScratchpadEntry =
  | { role: 'thought';     content: string }
  | { role: 'tool_call';   name: string; args: Record<string, unknown> }
  | { role: 'observation'; content: string };

interface AgentContext extends BaseContext {
  userQuery: string;
  scratchpad: ScratchpadEntry[];
  pendingToolCall?: { name: string; args: Record<string, unknown> };
  finalAnswer?: string;
}
```

The `scratchpad` is the agent's working memory — it accumulates thoughts,
tool calls, and observations across every loop iteration, giving the LLM full
history on each subsequent `think` call.

---

## Routing policy

`redirect` messages from steps are mapped to `GOTO` targets via `RedirectRoutingPolicy`.
The steps themselves never reference other step names — the route table owns that mapping.

```typescript
import { RedirectRoutingPolicy } from 'guidlio-lm';

const agentRoutes = new RedirectRoutingPolicy<AgentContext>({
  use_tool: 'act',
  think:    'think',
  answer:   'answer',
});
```

An unknown message produces a descriptive FAIL listing all known keys — misconfigured
routes surface immediately rather than silently doing nothing.

---

## Steps

### `think` — LLM decides the next action

```typescript
import { PipelineStep, StepResult, StepRunMeta, redirect, failed } from 'guidlio-lm';

type LLMDecision =
  | { type: 'use_tool'; thought: string; tool: { name: string; args: Record<string, unknown> } }
  | { type: 'answer';   thought: string; answer: string };

class ThinkStep extends PipelineStep<AgentContext> {
  readonly name = 'think';

  async run(ctx: AgentContext, meta: StepRunMeta): Promise<StepResult<AgentContext>> {
    // meta.attempt tells us how many times we have looped through think already.
    // Use it to detect a stuck agent (looping without making progress).
    if (meta.attempt > 8) {
      return failed({
        ctx,
        error: new Error('Agent exceeded maximum reasoning iterations'),
        retryable: false,
        statusCode: 422,
      });
    }

    let decision: LLMDecision;
    try {
      decision = await llm.reason({
        query:     ctx.userQuery,
        scratchpad: ctx.scratchpad,
        signal:    meta.signal,   // honour caller's AbortSignal inside the LLM call
      });
    } catch (err) {
      return failed({
        ctx,
        error: err instanceof Error ? err : new Error(String(err)),
        retryable: true, // transient LLM error — let the policy retry
      });
    }

    const thought: ScratchpadEntry = { role: 'thought', content: decision.thought };

    if (decision.type === 'use_tool') {
      return redirect({
        ctx: {
          ...ctx,
          pendingToolCall: decision.tool,
          scratchpad: [...ctx.scratchpad, thought],
        },
        message: 'use_tool',
      });
    }

    // LLM has enough information to answer
    return redirect({
      ctx: {
        ...ctx,
        finalAnswer: decision.answer,
        scratchpad: [...ctx.scratchpad, thought],
      },
      message: 'answer',
    });
  }
}
```

### `act` — Execute the chosen tool

```typescript
class ActStep extends PipelineStep<AgentContext> {
  readonly name = 'act';

  async run(ctx: AgentContext, meta: StepRunMeta): Promise<StepResult<AgentContext>> {
    if (!ctx.pendingToolCall) {
      return failed({ ctx, error: new Error('No pending tool call'), retryable: false });
    }

    const { name, args } = ctx.pendingToolCall;

    let observation: string;
    try {
      const result = await tools.call(name, args, meta.signal);
      observation = JSON.stringify(result);
    } catch (err) {
      // Tool errors become observations — the LLM should handle them gracefully
      observation = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }

    return redirect({
      ctx: {
        ...ctx,
        pendingToolCall: undefined,
        scratchpad: [
          ...ctx.scratchpad,
          { role: 'tool_call',   name, args },
          { role: 'observation', content: observation },
        ],
      },
      message: 'think', // always loop back to reasoning after acting
    });
  }
}
```

### `answer` — Finalize and return

```typescript
class AnswerStep extends PipelineStep<AgentContext> {
  readonly name = 'answer';

  async run(ctx: AgentContext, _meta: StepRunMeta): Promise<StepResult<AgentContext>> {
    // finalAnswer was set by ThinkStep. Return ok so the orchestrator stops.
    return ok({ ctx });
  }
}
```

---

## Wiring

```typescript
import { PipelineOrchestrator, LoggerPipelineObserver, RedirectRoutingPolicy } from 'guidlio-lm';

const orchestrator = new PipelineOrchestrator<AgentContext>({
  steps: [
    new ThinkStep(),
    new ActStep(),
    new AnswerStep(),
  ],
  // RedirectRoutingPolicy is stateless — sharing one instance is safe
  policy:   agentRoutes,
  observer: new LoggerPipelineObserver(),

  // Safety guard: a ReAct agent with 8 think iterations × 2 steps (think+act)
  // = 16 transitions. Set generously above your expected max to leave headroom.
  maxTransitions: 30,
});
```

---

## Running

```typescript
const result = await orchestrator.run({
  traceId:    'agent-001',
  userQuery:  'What is the current weather in Tel Aviv?',
  scratchpad: [],  // start with empty working memory
});

if (result.status === 'ok') {
  console.log('Answer:', result.ctx.finalAnswer);
  console.log('Steps taken:', result.ctx.scratchpad.length);
} else {
  console.error('Agent failed:', result.error.message);
  // Check result.error.statusCode === 422 for "exceeded iterations"
}
```

---

## Flow trace (example)

```
think (attempt 1)  → redirect:use_tool  → goto act
act                → redirect:think     → goto think
think (attempt 2)  → redirect:use_tool  → goto act
act                → redirect:think     → goto think
think (attempt 3)  → redirect:answer    → goto answer
answer             → next               → (pipeline ends, status: ok)
```

---

## Controlling loop depth

Two independent guards prevent infinite loops:

| Guard | Where | What it catches |
|---|---|---|
| `meta.attempt > N` check in `ThinkStep` | Inside the step | LLM looping without progress |
| `maxTransitions` on the orchestrator | Orchestrator loop | Any transition cycle |

The step-level guard produces a clean `failed` result with a meaningful message.
The orchestrator guard throws `PipelineDefinitionError` which propagates uncaught —
it indicates a programmer error (the guard was set too low or `reset()` wasn't called).
Keep `maxTransitions` well above your expected maximum so it only fires in true runaway scenarios.
