# Batched Embeddings and RAG Ingestion

`embedBatch` lets you embed many text chunks in a single API call, which is essential for RAG (Retrieval-Augmented Generation) ingestion pipelines where you need to embed hundreds or thousands of document chunks efficiently. This example builds a minimal RAG loop: ingest documents by chunking and embedding them, then retrieve relevant context by embedding a query and ranking by cosine similarity.

**Concepts covered:**
- Two-phase RAG: ingestion (embed documents) and retrieval (embed query, rank results)
- Chunking documents into ~512-token pieces
- `embedBatch` with `taskType: "RETRIEVAL_DOCUMENT"` for ingestion
- Batch size tradeoffs and per-provider recommendations
- Cosine similarity ranking for top-K retrieval
- `embed` with `taskType: "RETRIEVAL_QUERY"` for query-time embedding

---

## Phase 1: Ingestion

### Chunking

Embed models have per-request token limits. Chunking keeps each piece well within those limits and ensures semantically coherent retrieval. The function below uses a naive word-count approximation (1 word ≈ 1.3 tokens):

```typescript
function chunkText(text: string, targetTokens = 512): string[] {
	const wordsPerChunk = Math.floor(targetTokens / 1.3); // rough token estimate
	const words = text.split(/\s+/);
	const chunks: string[] = [];

	for (let i = 0; i < words.length; i += wordsPerChunk) {
		const chunk = words.slice(i, i + wordsPerChunk).join(" ");
		if (chunk.trim().length > 0) {
			chunks.push(chunk);
		}
	}

	return chunks;
}
```

For production use, replace this with a proper tokenizer (`tiktoken` for OpenAI, or a word-piece counter for Gemini) to stay within model-specific limits.

### Embedding a batch of chunks

```typescript
import { GuidlioLMService, GeminiProvider } from "guidlio-lm";

interface StoredChunk {
	chunkText: string;
	embedding: number[];
	documentId: string;
	chunkIndex: number;
}

const llm = new GuidlioLMService({
	providers: [new GeminiProvider(process.env.GEMINI_API_KEY!)],
});

// Stand-in for a vector database — in production use pgvector, Pinecone, Weaviate, etc.
const vectorStore: StoredChunk[] = [];

async function ingestDocument(documentId: string, text: string): Promise<void> {
	const chunks = chunkText(text);

	// Batch size recommendation:
	//   text-embedding-3-small (OpenAI): up to 100 chunks per call
	//   gemini-embedding-001 (Gemini):   up to 20 chunks per call (tighter per-request token limits)
	const batchSize = 20;

	for (let i = 0; i < chunks.length; i += batchSize) {
		const batch = chunks.slice(i, i + batchSize);

		const result = await llm.embedBatch({
			texts: batch,
			model: "gemini-embedding-001",
			dimensions: 768,
			// RETRIEVAL_DOCUMENT produces embeddings optimised for storage and ranking;
			// using RETRIEVAL_QUERY here would produce mismatched vector spaces
			taskType: "RETRIEVAL_DOCUMENT",
		});

		for (let j = 0; j < batch.length; j++) {
			vectorStore.push({
				chunkText: batch[j],
				embedding: result.embeddings[j],
				documentId,
				chunkIndex: i + j,
			});
		}
	}

	console.log(`Ingested "${documentId}": ${chunks.length} chunks, ${vectorStore.length} total stored`);
}
```

### Ingesting multiple documents

```typescript
const documents = [
	{ id: "doc-1", text: longArticle1 },
	{ id: "doc-2", text: longArticle2 },
	{ id: "doc-3", text: longArticle3 },
];

for (const doc of documents) {
	await ingestDocument(doc.id, doc.text);
}
```

Sequential ingestion avoids overwhelming provider rate limits. For large corpora, add a concurrency limiter (e.g. `p-limit`) to run a fixed number of documents in parallel.

---

## Phase 2: Retrieval

### Cosine similarity helper

```typescript
function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denominator = Math.sqrt(normA) * Math.sqrt(normB);
	// Guard against zero-magnitude vectors
	return denominator === 0 ? 0 : dot / denominator;
}
```

### Embedding the query and ranking chunks

```typescript
async function retrieve(query: string, topK = 5): Promise<StoredChunk[]> {
	// Query embeddings use a different task type so the model can optimise
	// for asymmetric retrieval (short query vs longer document chunk)
	const queryResult = await llm.embed({
		text: query,
		model: "gemini-embedding-001",
		dimensions: 768,
		taskType: "RETRIEVAL_QUERY",
	});

	const scored = vectorStore.map((chunk) => ({
		chunk,
		score: cosineSimilarity(queryResult.embedding, chunk.embedding),
	}));

	scored.sort((a, b) => b.score - a.score);

	return scored.slice(0, topK).map((s) => s.chunk);
}
```

### Using retrieved context in a generation call

```typescript
import { PromptRegistry } from "guidlio-lm";

const registry = new PromptRegistry();

registry.register({
	promptId: "rag-answer",
	version: 1,
	systemPrompt: "You are a helpful assistant. Answer questions using only the provided context. If the context does not contain the answer, say so.",
	userPrompt: "Context:\n{context}\n\nQuestion: {question}",
	modelDefaults: { model: "gemini-2.0-flash", temperature: 0.2 },
	output: { type: "text" },
});

const llmWithRegistry = new GuidlioLMService({
	providers: [new GeminiProvider(process.env.GEMINI_API_KEY!)],
	promptRegistry: registry,
});

async function answerQuestion(question: string): Promise<string> {
	const relevantChunks = await retrieve(question, 5);
	const context = relevantChunks.map((c) => c.chunkText).join("\n\n---\n\n");

	const result = await llmWithRegistry.callText({
		promptId: "rag-answer",
		variables: { context, question },
	});

	return result.text;
}

const answer = await answerQuestion("What are the main findings of the study?");
console.log(answer);
```

---

## Batch size recommendations

| Model | Recommended batch size | Reason |
| :--- | :--- | :--- |
| `text-embedding-3-small` (OpenAI) | 100 chunks | High per-request token limit; larger batches = fewer API calls |
| `text-embedding-3-large` (OpenAI) | 100 chunks | Same limits as small; costs more per token |
| `gemini-embedding-001` (Gemini) | 20 chunks | Tighter per-request input token limits |

Reduce batch size if you see `LLMPermanentError` with a 400 status code — that usually indicates the batch exceeded the model's token limit. Increase if you are processing a large corpus and want fewer round-trips.

---

## What to change next

- [04-embeddings.md](./04-embeddings.md) — single-item `embed` reference and provider-specific embedding parameters
- [08-cancellation-and-timeouts.md](./08-cancellation-and-timeouts.md) — pass `signal` to `embedBatch` to cancel long ingestion jobs when the parent process is shutting down
