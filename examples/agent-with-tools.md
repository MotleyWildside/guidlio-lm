# Tool-Using Agent

A minimal ReAct-style agent that lets an LLM choose between tools, execute them, observe results, and loop until it has enough information to produce a final answer. The agent loop is driven entirely by `redirect` outcomes and `RedirectRoutingPolicy` — no custom policy subclassing required.

**Concepts covered:**
- `redirect` outcome to implement a stateful decision loop
- `RedirectRoutingPolicy` mapping semantic action names to step names
- Accumulating observations in a `scratchpad` string array on the context
- `meta.attempt` as a loop-count guard against stuck agents
- `maxTransitions` as a hard safety cap on total transitions
- Stub tool implementations that are easy to swap for real ones

---

## Context

```typescript
import { BaseContext } from "guidlio-lm";

interface AgentContext extends BaseContext {
	query: string;
	scratchpad: string[];
	pendingTool?: "calculator" | "search";
	pendingArgs?: Record<string, string | number>;
	toolResult?: string;
	answer?: string;
}
```

---

## Tool implementations

```typescript
// Stub implementations — replace with real logic or external API calls

function runCalculator(args: Record<string, string | number>): string {
	const expr = String(args["expression"] ?? "");
	// Evaluate simple arithmetic safely. For production use a proper math parser.
	try {
		// Only allow digits, operators, spaces, and parentheses
		if (!/^[\d\s+\-*/().]+$/.test(expr)) return "Error: unsupported expression";
		// eslint-disable-next-line no-new-func
		const result = Function(`"use strict"; return (${expr})`)() as number;
		return String(result);
	} catch {
		return "Error: could not evaluate expression";
	}
}

function runSearch(args: Record<string, string | number>): string {
	const query = String(args["query"] ?? "");
	// Stub: in production call a search API (Tavily, SerpAPI, etc.)
	return `Stub search result for "${query}": No real data — replace with actual search client.`;
}
```

---

## Prompts and service setup

```typescript
import {
	GuidlioLMService,
	OpenAIProvider,
	PromptRegistry,
} from "guidlio-lm";
import { z } from "zod";

const registry = new PromptRegistry();

const ToolDecisionSchema = z.object({
	action: z.enum(["calculator", "search", "answer"]),
	args: z.record(z.union([z.string(), z.number()])).optional(),
	thought: z.string(),
});

registry.register({
	promptId: "agent_select_tool",
	version: 1,
	systemPrompt:
		"You are an agent that can use tools to answer questions.\n" +
		"Available tools:\n" +
		"  - calculator: evaluates arithmetic. Args: { expression: string }\n" +
		"  - search: looks up information. Args: { query: string }\n" +
		"  - answer: produces the final answer. No args needed.\n\n" +
		"Respond with a JSON object containing: action, optional args, and a thought " +
		"explaining your reasoning.",
	userPrompt:
		"Question: {query}\n\nPrevious observations:\n{scratchpad}\n\nWhat should I do next?",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.2 },
	output: { type: "json" },
});

registry.register({
	promptId: "agent_answer",
	version: 1,
	systemPrompt: "You produce a final answer based on gathered observations.",
	userPrompt:
		"Question: {query}\n\nObservations collected:\n{scratchpad}\n\nAnswer concisely.",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});
```

---

## Steps

```typescript
import {
	PipelineStep,
	StepResult,
	StepRunMeta,
	ok,
	failed,
	redirect,
} from "guidlio-lm";

class SelectToolStep extends PipelineStep<AgentContext> {
	readonly name = "select-tool";

	constructor(private readonly llmSvc: GuidlioLMService) {
		super();
	}

	async run(ctx: AgentContext, meta: StepRunMeta): Promise<StepResult<AgentContext>> {
		// Guard against stuck loops: if we have been selecting tools too many times,
		// force the agent to produce an answer with whatever it has.
		if (meta.attempt > 8) {
			return redirect({
				ctx: { ...ctx, scratchpad: [...ctx.scratchpad, "[max tool calls reached]"] },
				message: "answer",
			});
		}

		const result = await this.llmSvc.callJSON({
			promptId: "agent_select_tool",
			variables: {
				query: ctx.query,
				scratchpad: ctx.scratchpad.length > 0 ? ctx.scratchpad.join("\n") : "(none yet)",
			},
			jsonSchema: ToolDecisionSchema,
			signal: meta.signal,
		});

		const { action, args, thought } = result.data;
		const updatedScratchpad = [...ctx.scratchpad, `Thought: ${thought}`];

		return redirect({
			ctx: {
				...ctx,
				scratchpad: updatedScratchpad,
				pendingTool: action === "answer" ? undefined : action,
				pendingArgs: args ?? {},
			},
			message: action, // "calculator" | "search" | "answer"
		});
	}
}

class RunCalculatorStep extends PipelineStep<AgentContext> {
	readonly name = "run-calculator";

	async run(ctx: AgentContext, _meta: StepRunMeta): Promise<StepResult<AgentContext>> {
		const toolResult = runCalculator(ctx.pendingArgs ?? {});
		return redirect({
			ctx: { ...ctx, toolResult },
			message: "observe",
		});
	}
}

class RunSearchStep extends PipelineStep<AgentContext> {
	readonly name = "run-search";

	async run(ctx: AgentContext, _meta: StepRunMeta): Promise<StepResult<AgentContext>> {
		const toolResult = runSearch(ctx.pendingArgs ?? {});
		return redirect({
			ctx: { ...ctx, toolResult },
			message: "observe",
		});
	}
}

class ObserveStep extends PipelineStep<AgentContext> {
	readonly name = "observe";

	async run(ctx: AgentContext, _meta: StepRunMeta): Promise<StepResult<AgentContext>> {
		const observation = `Observation: ${ctx.toolResult ?? "(no result)"}`;
		return redirect({
			ctx: {
				...ctx,
				scratchpad: [...ctx.scratchpad, observation],
				pendingTool: undefined,
				pendingArgs: undefined,
				toolResult: undefined,
			},
			message: "select-tool", // loop back for the next tool decision
		});
	}
}

class AnswerStep extends PipelineStep<AgentContext> {
	readonly name = "answer";

	constructor(private readonly llmSvc: GuidlioLMService) {
		super();
	}

	async run(ctx: AgentContext, meta: StepRunMeta): Promise<StepResult<AgentContext>> {
		const result = await this.llmSvc.callText({
			promptId: "agent_answer",
			variables: {
				query: ctx.query,
				scratchpad: ctx.scratchpad.join("\n"),
			},
			signal: meta.signal,
		});
		return ok({ ctx: { ...ctx, answer: result.text } });
	}
}
```

---

## Wiring

```typescript
import { GuidlioOrchestrator, RedirectRoutingPolicy } from "guidlio-lm";

const orchestrator = new GuidlioOrchestrator<AgentContext>({
	steps: [
		new SelectToolStep(llm),
		new RunCalculatorStep(),
		new RunSearchStep(),
		new ObserveStep(),
		new AnswerStep(llm),
	],
	policy: () =>
		new RedirectRoutingPolicy({
			calculator: "run-calculator",
			search: "run-search",
			observe: "observe",
			"select-tool": "select-tool",
			answer: "answer",
		}),
	// Hard cap: prevents infinite loops if the policy ever routes back without
	// making progress. Each tool call costs 3 transitions (select → run → observe).
	// 30 transitions supports up to 9 tool calls plus the final answer.
	maxTransitions: 30,
});
```

---

## Running

```typescript
const result = await orchestrator.run({
	traceId: crypto.randomUUID(),
	query: "What is (145 + 37) * 12?",
	scratchpad: [],
});

if (result.status === "ok") {
	console.log("Answer:", result.ctx.answer);
	console.log("Scratchpad:", result.ctx.scratchpad);
} else {
	console.error("Agent failed:", result.error.message);
}
```

---

## What to change next

- [Agent plan-execute-verify](../src/orchestrator/examples/agent-plan-execute-verify.md) — a more structured planning agent with a verify step
- [Multi-provider fallback](multi-provider-fallback.md) — run the agent on a fallback model when the primary is unavailable
