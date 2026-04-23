# Custom Provider — Local llama.cpp Server

When you run a local `llama.cpp` HTTP server you want GuidlioLMService's prompt registry, caching, and retry machinery to work with it just as with any cloud provider. Implementing `LLMProvider` against the `/completion` endpoint connects local models to the full service stack without any SDK dependency — only Node's built-in `fetch`.

## Concepts covered

- Matching a custom model-name namespace (`"local/"` prefix) in `supportsModel`
- POSTing to a llama.cpp `/completion` endpoint and normalising the response shape
- SSE streaming: reading a `ReadableStream` line-by-line and parsing `data: {...}` frames
- Mapping HTTP status codes to `LLMTransientError` / `LLMPermanentError`
- Forwarding `request.signal` to both plain and streaming `fetch` calls
- Throwing `LLMPermanentError` for unsupported operations (embeddings)

## No extra dependencies

llama.cpp exposes a plain HTTP API. This provider uses only Node.js built-in `fetch` (Node 18+).

## Implementation

```typescript
import type {
	LLMProvider,
	ProviderRequest,
	LLMProviderResponse,
	LLMProviderStreamResponse,
	LLMEmbedRequest,
	LLMEmbedResponse,
	LLMEmbedBatchRequest,
	LLMEmbedBatchResponse,
} from "guidlio-lm";
import { LLMTransientError, LLMPermanentError } from "guidlio-lm";

interface LlamaCppCompletionResponse {
	content: string;
	stop: boolean;
	tokens_predicted?: number;
	tokens_evaluated?: number;
}

export class LlamaCppProvider implements LLMProvider {
	readonly name = "llamacpp";

	private baseUrl: string;

	constructor(baseUrl = "http://localhost:8080") {
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}

	// Only handle models explicitly namespaced to this provider
	supportsModel(model: string): boolean {
		return model.startsWith("local/");
	}

	async call(request: ProviderRequest): Promise<LLMProviderResponse> {
		// llama.cpp /completion takes a flat prompt string, not a message array.
		// Concatenate the messages in a simple chat format.
		const prompt = this.formatMessages(request.messages);

		const response = await fetch(`${this.baseUrl}/completion`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: request.signal,
			body: JSON.stringify({
				prompt,
				temperature: request.temperature,
				n_predict: request.maxTokens ?? 512,
				top_p: request.topP ?? 1,
				seed: request.seed ?? -1,
				stream: false,
			}),
		});

		if (!response.ok) {
			throw this.mapHttpError(response.status, request.model);
		}

		const body = (await response.json()) as LlamaCppCompletionResponse;

		const promptTokens = body.tokens_evaluated ?? 0;
		const completionTokens = body.tokens_predicted ?? 0;

		return {
			text: body.content,
			usage: {
				promptTokens,
				completionTokens,
				totalTokens: promptTokens + completionTokens,
			},
			finishReason: body.stop ? "stop" : "length",
		};
	}

	async callStream(request: ProviderRequest): Promise<LLMProviderStreamResponse> {
		const prompt = this.formatMessages(request.messages);

		const response = await fetch(`${this.baseUrl}/completion`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: request.signal,
			body: JSON.stringify({
				prompt,
				temperature: request.temperature,
				n_predict: request.maxTokens ?? 512,
				top_p: request.topP ?? 1,
				seed: request.seed ?? -1,
				stream: true, // llama.cpp streams SSE when this is true
			}),
		});

		if (!response.ok) {
			throw this.mapHttpError(response.status, request.model);
		}

		// llama.cpp sends Server-Sent Events: lines starting with "data: "
		const body = response.body;
		if (!body) {
			throw new LLMPermanentError("llama.cpp returned an empty response body", {
				provider: this.name,
				model: request.model,
			});
		}

		const providerName = this.name;
		let accumulatedText = "";

		const stream: AsyncIterable<{ text: string; delta: string }> = {
			[Symbol.asyncIterator]() {
				return (async function* () {
					const reader = body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";

					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;

							buffer += decoder.decode(value, { stream: true });

							// SSE frames are newline-delimited; process complete lines only
							const lines = buffer.split("\n");
							buffer = lines.pop() ?? ""; // keep the incomplete trailing fragment

							for (const line of lines) {
								if (!line.startsWith("data: ")) continue;

								const raw = line.slice("data: ".length).trim();
								if (!raw || raw === "[DONE]") continue;

								let frame: LlamaCppCompletionResponse;
								try {
									frame = JSON.parse(raw) as LlamaCppCompletionResponse;
								} catch {
									// Malformed frame — skip rather than crash the stream
									continue;
								}

								const delta = frame.content;
								accumulatedText += delta;
								yield { text: accumulatedText, delta };

								if (frame.stop) break;
							}
						}
					} finally {
						reader.releaseLock();
					}
				})();
			},
		};

		return { stream };
	}

	// llama.cpp is a completion server, not an embedding server.
	// Use a dedicated embedding endpoint or a different provider for embed() calls.
	async embed(_request: LLMEmbedRequest): Promise<LLMEmbedResponse> {
		throw new LLMPermanentError(
			"LlamaCppProvider does not support embeddings — use a dedicated embedding model",
			{ provider: this.name, model: _request.model },
		);
	}

	async embedBatch(_request: LLMEmbedBatchRequest): Promise<LLMEmbedBatchResponse> {
		throw new LLMPermanentError(
			"LlamaCppProvider does not support embeddings — use a dedicated embedding model",
			{ provider: this.name, model: _request.model },
		);
	}

	// Concatenate all messages into a simple role: content format
	private formatMessages(
		messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
	): string {
		return messages
			.map((m) => {
				if (m.role === "system") return `System: ${m.content}`;
				if (m.role === "assistant") return `Assistant: ${m.content}`;
				return `User: ${m.content}`;
			})
			.join("\n\n");
	}

	private mapHttpError(status: number, model: string): LLMTransientError | LLMPermanentError {
		if (status >= 500) {
			return new LLMTransientError(`llama.cpp server error (HTTP ${status})`, {
				provider: this.name,
				model,
				statusCode: status,
			});
		}
		return new LLMPermanentError(`llama.cpp request error (HTTP ${status})`, {
			provider: this.name,
			model,
			statusCode: status,
		});
	}
}
```

## Wiring into GuidlioLMService

Model names must use the `"local/"` prefix so `supportsModel` matches them.

```typescript
import { GuidlioLMService, PromptRegistry } from "guidlio-lm";
import { LlamaCppProvider } from "./LlamaCppProvider";

const registry = new PromptRegistry();

registry.register({
	promptId: "local-summarize",
	version: 1,
	systemPrompt: "Summarize the following text in one paragraph.",
	userPrompt: "{text}",
	// Use any model name starting with "local/" — the string after the slash is
	// passed to the server but llama.cpp ignores it (it uses whichever model is loaded)
	modelDefaults: { model: "local/default", temperature: 0.4, maxTokens: 256 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [new LlamaCppProvider("http://localhost:8080")],
	promptRegistry: registry,
});

const result = await llm.callText({
	promptId: "local-summarize",
	variables: { text: "The Cambrian explosion was a rapid diversification of animal life..." },
});

console.log(result.text);
```

## Mixing with cloud providers

Because `supportsModel` is prefix-based you can register the local provider alongside cloud providers. The service routes `"local/*"` calls to llama.cpp and everything else to the appropriate cloud provider.

```typescript
import { OpenAIProvider } from "guidlio-lm";

const llm = new GuidlioLMService({
	providers: [
		new LlamaCppProvider(),
		new OpenAIProvider(process.env.OPENAI_API_KEY!),
	],
	promptRegistry: registry,
});

// Routed to llama.cpp
await llm.callText({ promptId: "local-summarize", variables: { text } });

// Routed to OpenAI
await llm.callText({ promptId: "gpt-task", model: "gpt-4o-mini", variables: {} });
```

## What to change next

- Build a deterministic version of this provider for unit tests — see [custom-provider-mock-testing.md](./custom-provider-mock-testing.md).
- Combine the local provider with caching to avoid re-running expensive local inference — see [06-caching.md](../06-caching.md).
