# LLM Service Module

The `LLMService` module is the core gateway for all Large Language Model interactions within the package. It provides a unified interface for text generation, JSON extraction, streaming, and embeddings, regardless of the underlying provider (OpenAI, Google, etc.).

## Key Features

- **Provider Agnostic**: Unified API for multiple LLM providers.
- **Robust JSON Extraction**: Built-in JSON repair logic and Zod schema validation.
- **Prompt Management**: Integration with `PromptRegistry` for versioned templates.
- **Resilience**: Automatic exponential backoff retries for transient failures.
- **Performance**: Integrated read-through and refresh caching mechanisms.
- **Observability**: Structured logging for tracking costs, latency, and success rates.

## Core API

### `LLMService`

The main class used to interact with LLMs.

#### Methods

| Method | Description |
| :--- | :--- |
| `callText(params)` | Returns a standard text response from the model. |
| `callJSON<T>(params)` | Returns a parsed and validated JSON object. Attempts to repair malformed JSON if necessary. |
| `callStream(params)` | Returns a text stream for real-time output. |
| `embed(params)` | Generates a vector embedding for a single string. |
| `embedBatch(params)` | Generates embeddings for an array of strings in a single request. |

## Usage Example

```typescript
import { LLMService } from './LLMService';
import { OpenAIProvider } from './providers/OpenAIProvider';

const llm = new LLMService({
  providers: [new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY })],
  defaultProvider: 'openai'
});

// Generate structured JSON
const result = await llm.callJSON({
  promptId: 'analyze-sentiment',
  variables: { text: "I love this library!" },
  jsonSchema: z.object({ sentiment: z.string(), score: z.number() })
});

console.log(result.data.sentiment); // "positive"
```

## Internal Structure

- `/providers`: Implementation of specific LLM adapters (OpenAI, Gemini, etc.).
- `/prompts-registry`: Logic for managing and versioning prompt templates.
- `/cache`: Caching strategies (In-memory, etc.).
- `types.ts`: Shared interfaces and parameter definitions.
- `errors.ts`: Custom error classes for transient and permanent failures.
