# Embeddings

`embed` and `embedBatch` share the same retry pipeline as text generation. Neither method uses `PromptRegistry` — you pass text directly.

## Single embedding

```typescript
import { LLMService, OpenAIProvider } from "guidlio-lm";

const llm = new LLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
});

const result = await llm.embed({
	model: "text-embedding-3-small",
	text: "TypeScript is a strongly-typed superset of JavaScript.",
});

console.log(result.embedding.length); // 1536 (default) or custom dimensions
console.log(result.usage?.totalTokens);
```

## Controlling dimensions

`text-embedding-3-small` and `text-embedding-3-large` support the `dimensions` parameter to produce shorter vectors at the cost of some precision.

```typescript
const compact = await llm.embed({
	model: "text-embedding-3-small",
	text: "some document",
	dimensions: 256,
});
// compact.embedding.length === 256
```

## Batch embedding

One API call for many texts — more efficient than N individual `embed` calls.

```typescript
const documents = [
	"How do I reset my password?",
	"What are your pricing plans?",
	"How do I cancel my subscription?",
];

const { embeddings, usage } = await llm.embedBatch({
	model: "text-embedding-3-small",
	texts: documents,
	dimensions: 512,
});

// embeddings[i] corresponds to documents[i]
console.log(embeddings.length);    // 3
console.log(embeddings[0].length); // 512
console.log(usage?.totalTokens);
```

## Semantic similarity search (cosine)

```typescript
function cosineSimilarity(a: number[], b: number[]): number {
	const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
	const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
	const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
	return dot / (normA * normB);
}

const query = await llm.embed({
	model: "text-embedding-3-small",
	text: "I forgot my login details",
	taskType: "RETRIEVAL_QUERY",
});

const docEmbeds = await llm.embedBatch({
	model: "text-embedding-3-small",
	texts: documents,
	taskType: "RETRIEVAL_DOCUMENT",
});

const scores = docEmbeds.embeddings.map((emb, i) => ({
	text: documents[i],
	score: cosineSimilarity(query.embedding, emb),
}));

scores.sort((a, b) => b.score - a.score);
console.log(scores[0].text);
// "How do I reset my password?"
```

## Propagating trace IDs and cancellation

```typescript
const result = await llm.embed({
	model: "text-embedding-3-small",
	text: "...",
	traceId: req.headers["x-trace-id"] as string,
	signal: abortController.signal,
});
```

## Provider support

| Provider | `embed` | `embedBatch` | Notes |
| :--- | :--- | :--- | :--- |
| `OpenAIProvider` | Yes | Yes | `text-embedding-3-*`, `text-embedding-ada-002` |
| `GeminiProvider` | Yes | Yes | `gemini-embedding-*`; supports `taskType` |
| `OpenRouterProvider` | No | No | Throws immediately — not supported by OpenRouter |
