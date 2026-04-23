# RAG Pipeline

Retrieval-Augmented Generation combines the precision of document retrieval with the fluency of LLM generation. This recipe shows how to wire embed → retrieve → rerank → generate as a four-step orchestrator pipeline, using `GuidlioLMService` for every LLM operation and the orchestrator's `degrade` transition to handle zero-hit retrievals gracefully.

**Concepts covered:**
- `llm.embed()` with `taskType: "RETRIEVAL_QUERY"` for query-optimized embeddings
- Cosine similarity scoring against an in-memory document store
- `llm.callJSON()` to rerank candidate passages
- `llm.callText()` for final answer generation
- `redirect` outcome from a step, `DefaultPolicy` subclass that checks context
- `degrade` transition for graceful partial failures
- `meta.signal` threaded through every LLM call for cooperative cancellation
- `LoggerPipelineObserver` for structured pipeline logging

---

## Context

```typescript
import { BaseContext } from "guidlio-lm";

interface Document {
	id: string;
	text: string;
	embedding?: number[];
}

interface RagContext extends BaseContext {
	userQuery: string;
	queryEmbedding?: number[];
	candidates?: Array<{ doc: Document; score: number }>;
	rankedCandidates?: Document[];
	answer?: string;
}
```

---

## Document store

```typescript
// For production: replace this with a vector DB client call (Pinecone, pgvector, etc.)
const DOCUMENTS: Document[] = [
	{
		id: "doc-1",
		text: "TypeScript is a strongly typed programming language that builds on JavaScript.",
		embedding: [0.1, 0.8, 0.3],
	},
	{
		id: "doc-2",
		text: "Node.js enables running JavaScript on the server using the V8 engine.",
		embedding: [0.2, 0.7, 0.4],
	},
	{
		id: "doc-3",
		text: "LLMs are neural networks trained on large text corpora to generate human-like text.",
		embedding: [0.9, 0.1, 0.6],
	},
	{
		id: "doc-4",
		text: "Vector databases store high-dimensional embeddings for similarity search.",
		embedding: [0.8, 0.2, 0.7],
	},
	{
		id: "doc-5",
		text: "Retrieval-augmented generation grounds LLM responses in retrieved documents.",
		embedding: [0.85, 0.15, 0.65],
	},
];

function cosineSimilarity(a: number[], b: number[]): number {
	const dot = a.reduce((sum, val, i) => sum + val * (b[i] ?? 0), 0);
	const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
	const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
	if (normA === 0 || normB === 0) return 0;
	return dot / (normA * normB);
}
```

---

## Service setup

```typescript
import {
	GuidlioLMService,
	GeminiProvider,
	OpenAIProvider,
	PromptRegistry,
	ConsoleLogger,
} from "guidlio-lm";

const registry = new PromptRegistry();

registry.register({
	promptId: "rag_rerank",
	version: 1,
	systemPrompt: "You are a relevance ranking assistant. Return only valid JSON.",
	userPrompt:
		"Query: {query}\n\nPassages:\n{passages}\n\nReturn a JSON object with a single key " +
		'"rankedIds" containing the passage IDs sorted from most to least relevant. ' +
		"Include only IDs that are genuinely relevant.",
	modelDefaults: { model: "gemini-2.0-flash", temperature: 0 },
	output: { type: "json" },
});

registry.register({
	promptId: "rag_generate",
	version: 1,
	systemPrompt:
		"You are a helpful assistant. Answer the user's question using only the provided context. " +
		"If the context does not contain enough information, say so.",
	userPrompt: "Context:\n{context}\n\nQuestion: {question}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [
		new OpenAIProvider(process.env.OPENAI_API_KEY!),
		new GeminiProvider(process.env.GEMINI_API_KEY!),
	],
	promptRegistry: registry,
	logger: new ConsoleLogger(),
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
import { z } from "zod";

class EmbedQueryStep extends PipelineStep<RagContext> {
	readonly name = "embed-query";

	constructor(private readonly llmSvc: GuidlioLMService) {
		super();
	}

	async run(ctx: RagContext, meta: StepRunMeta): Promise<StepResult<RagContext>> {
		const result = await this.llmSvc.embed({
			model: "text-embedding-3-small",
			input: ctx.userQuery,
			taskType: "RETRIEVAL_QUERY",
			signal: meta.signal,
		});
		return ok({ ctx: { ...ctx, queryEmbedding: result.embedding } });
	}
}

class RetrieveStep extends PipelineStep<RagContext> {
	readonly name = "retrieve";

	async run(ctx: RagContext, _meta: StepRunMeta): Promise<StepResult<RagContext>> {
		const embedding = ctx.queryEmbedding;
		if (!embedding) {
			return failed({ ctx, error: new Error("queryEmbedding missing"), retryable: false });
		}

		const scored = DOCUMENTS.filter((d) => d.embedding != null).map((doc) => ({
			doc,
			score: cosineSimilarity(embedding, doc.embedding!),
		}));

		// Sort descending and take top 10
		scored.sort((a, b) => b.score - a.score);
		const candidates = scored.slice(0, 10);

		// Return ok even on empty — the policy will handle the degrade transition
		return ok({ ctx: { ...ctx, candidates } });
	}
}

const RerankSchema = z.object({
	rankedIds: z.array(z.string()),
});

class RerankStep extends PipelineStep<RagContext> {
	readonly name = "rerank";

	constructor(private readonly llmSvc: GuidlioLMService) {
		super();
	}

	async run(ctx: RagContext, meta: StepRunMeta): Promise<StepResult<RagContext>> {
		const candidates = ctx.candidates ?? [];
		if (candidates.length === 0) {
			return ok({ ctx: { ...ctx, rankedCandidates: [] } });
		}

		const passageLines = candidates
			.map((c, i) => `[${c.doc.id}] (score: ${c.score.toFixed(3)}) ${c.doc.text}`)
			.join("\n");

		const result = await this.llmSvc.callJSON({
			promptId: "rag_rerank",
			variables: {
				query: ctx.userQuery,
				passages: passageLines,
			},
			jsonSchema: RerankSchema,
			signal: meta.signal,
		});

		// Keep top 3 in ranked order
		const idSet = new Map(candidates.map((c) => [c.doc.id, c.doc]));
		const rankedCandidates = result.data.rankedIds
			.slice(0, 3)
			.map((id) => idSet.get(id))
			.filter((d): d is Document => d != null);

		return ok({ ctx: { ...ctx, rankedCandidates } });
	}
}

class GenerateStep extends PipelineStep<RagContext> {
	readonly name = "generate";

	constructor(private readonly llmSvc: GuidlioLMService) {
		super();
	}

	async run(ctx: RagContext, meta: StepRunMeta): Promise<StepResult<RagContext>> {
		const docs = ctx.rankedCandidates ?? [];
		const contextText = docs.map((d, i) => `[${i + 1}] ${d.text}`).join("\n\n");

		const result = await this.llmSvc.callText({
			promptId: "rag_generate",
			variables: {
				context: contextText,
				question: ctx.userQuery,
			},
			signal: meta.signal,
		});

		return ok({ ctx: { ...ctx, answer: result.text } });
	}
}
```

---

## Policy

The policy degrades instead of failing when retrieval returns zero candidates. This lets the caller decide whether a "no results" answer is acceptable rather than treating it as a pipeline error.

```typescript
import { DefaultPolicy, PolicyDecisionInput, PolicyDecisionOutput } from "guidlio-lm";

class RagPolicy extends DefaultPolicy<RagContext> {
	override ok(
		outcome: { ctx: RagContext },
		input: PolicyDecisionInput<RagContext>,
	): PolicyDecisionOutput<RagContext> {
		// After the retrieve step, degrade if there are no candidates at all
		if (
			input.stepName === "retrieve" &&
			(outcome.ctx.candidates == null || outcome.ctx.candidates.length === 0)
		) {
			return {
				transition: {
					type: "degrade",
					reason: "No documents matched the query embedding",
				},
			};
		}
		return super.ok(outcome, input);
	}
}
```

---

## Wiring

```typescript
import { GuidlioOrchestrator, LoggerPipelineObserver } from "guidlio-lm";

const orchestrator = new GuidlioOrchestrator<RagContext>({
	steps: [
		new EmbedQueryStep(llm),
		new RetrieveStep(),
		new RerankStep(llm),
		new GenerateStep(llm),
	],
	policy: () => new RagPolicy(),
	observer: new LoggerPipelineObserver(new ConsoleLogger()),
	maxTransitions: 20,
});
```

---

## Running

```typescript
const result = await orchestrator.run({
	traceId: crypto.randomUUID(),
	userQuery: "What is retrieval-augmented generation?",
});

if (result.status === "ok") {
	if (result.degraded) {
		console.log("No relevant documents found. Answer may be incomplete.");
		console.log("Degraded reason:", result.degraded.reason);
	} else {
		console.log("Answer:", result.ctx.answer);
	}
} else {
	console.error("Pipeline failed:", result.error.message);
}
```

---

## What to change next

- [Streaming answer generation](../src/llm-service/examples/03-streaming.md) — pipe the generate step output as SSE instead of a single text result
- [Streaming UI server](streaming-ui-server.md) — expose the pipeline through an HTTP endpoint with live streaming
