# Custom Provider — Anthropic SDK

When you want to call Anthropic's Claude models directly through the official `@anthropic-ai/sdk` rather than through OpenRouter, you implement the `LLMProvider` interface yourself. This gives you full control over request parameters, streaming behaviour, and error classification — and lets the service's retry, caching, and prompt-registry machinery work with Anthropic exactly as it does with any built-in provider.

## Concepts covered

- Implementing every method of the `LLMProvider` interface
- Mapping `ProviderRequest.messages` to Anthropic's `MessageParam` shape
- Translating Anthropic error codes into `LLMTransientError` / `LLMPermanentError`
- Streaming via `client.messages.stream()` and yielding `{ text, delta }` chunks
- Throwing `LLMPermanentError` for unsupported operations (embeddings)
- Forwarding `request.signal` for cancellation

## Installation

`@anthropic-ai/sdk` is a peer dependency — install it alongside `guidlio-lm`:

```bash
npm install @anthropic-ai/sdk
```

## Implementation

```typescript
import Anthropic from "@anthropic-ai/sdk";
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

export class AnthropicProvider implements LLMProvider {
	readonly name = "anthropic";

	private client: Anthropic;

	constructor(apiKey: string) {
		this.client = new Anthropic({ apiKey });
	}

	supportsModel(model: string): boolean {
		return model.startsWith("claude-");
	}

	async call(request: ProviderRequest): Promise<LLMProviderResponse> {
		// Anthropic separates the system prompt from the message array
		const systemMessages = request.messages.filter((m) => m.role === "system");
		const userAssistantMessages = request.messages.filter((m) => m.role !== "system");

		const system = systemMessages.map((m) => m.content).join("\n") || undefined;

		// Anthropic's SDK types require explicit "user" | "assistant" roles
		const messages = userAssistantMessages.map((m) => ({
			role: m.role as "user" | "assistant",
			content: m.content,
		}));

		try {
			const response = await this.client.messages.create(
				{
					model: request.model,
					max_tokens: request.maxTokens ?? 4096,
					temperature: request.temperature,
					top_p: request.topP,
					system,
					messages,
				},
				{ signal: request.signal },
			);

			const text = response.content
				.filter((block): block is Anthropic.TextBlock => block.type === "text")
				.map((block) => block.text)
				.join("");

			return {
				text,
				usage: {
					promptTokens: response.usage.input_tokens,
					completionTokens: response.usage.output_tokens,
					totalTokens: response.usage.input_tokens + response.usage.output_tokens,
				},
				finishReason: response.stop_reason ?? undefined,
				requestId: response.id,
			};
		} catch (err) {
			throw this.mapError(err, request.model);
		}
	}

	async callStream(request: ProviderRequest): Promise<LLMProviderStreamResponse> {
		const systemMessages = request.messages.filter((m) => m.role === "system");
		const userAssistantMessages = request.messages.filter((m) => m.role !== "system");

		const system = systemMessages.map((m) => m.content).join("\n") || undefined;

		const messages = userAssistantMessages.map((m) => ({
			role: m.role as "user" | "assistant",
			content: m.content,
		}));

		// client.messages.stream() returns an event-emitting helper — we wrap it as AsyncIterable
		const sdkStream = this.client.messages.stream(
			{
				model: request.model,
				max_tokens: request.maxTokens ?? 4096,
				temperature: request.temperature,
				top_p: request.topP,
				system,
				messages,
			},
			{ signal: request.signal },
		);

		let accumulatedText = "";

		const stream: AsyncIterable<{ text: string; delta: string }> = {
			[Symbol.asyncIterator]() {
				// The SDK exposes an async iterable of raw events
				const eventIter = sdkStream as AsyncIterable<Anthropic.MessageStreamEvent>;
				return (async function* () {
					for await (const event of eventIter) {
						// text_delta carries the new characters; all other event types are metadata
						if (
							event.type === "content_block_delta" &&
							event.delta.type === "text_delta"
						) {
							const delta = event.delta.text;
							accumulatedText += delta;
							yield { text: accumulatedText, delta };
						}
					}
				})();
			},
		};

		return { stream };
	}

	// Anthropic does not provide an embedding API as of this writing.
	// Throw LLMPermanentError so the retry loop does not waste attempts on an unsupported path.
	async embed(_request: LLMEmbedRequest): Promise<LLMEmbedResponse> {
		throw new LLMPermanentError(
			"AnthropicProvider does not support embeddings — use OpenAIProvider or GeminiProvider for embed() calls",
			{ provider: this.name, model: _request.model },
		);
	}

	async embedBatch(_request: LLMEmbedBatchRequest): Promise<LLMEmbedBatchResponse> {
		throw new LLMPermanentError(
			"AnthropicProvider does not support embeddings — use OpenAIProvider or GeminiProvider for embedBatch() calls",
			{ provider: this.name, model: _request.model },
		);
	}

	private mapError(err: unknown, model: string): LLMTransientError | LLMPermanentError {
		if (err instanceof Anthropic.APIError) {
			const status = err.status;
			const isTransient =
				status === 429 || // rate limit
				status >= 500 || // server errors
				err.error?.type === "overloaded_error"; // Anthropic-specific overload signal

			if (isTransient) {
				return new LLMTransientError(err.message, {
					provider: this.name,
					model,
					statusCode: status,
					cause: err,
				});
			}

			// 401 invalid auth, 403 permission denied, 400 bad request — permanent
			return new LLMPermanentError(err.message, {
				provider: this.name,
				model,
				statusCode: status,
				cause: err,
			});
		}

		// Network-level errors (ECONNRESET, ETIMEDOUT) are transient
		return new LLMTransientError("Network error communicating with Anthropic", {
			provider: this.name,
			model,
			cause: err instanceof Error ? err : new Error(String(err)),
		});
	}
}
```

## Wiring into GuidlioLMService

```typescript
import { GuidlioLMService, PromptRegistry } from "guidlio-lm";
import { AnthropicProvider } from "./AnthropicProvider";

const registry = new PromptRegistry();

registry.register({
	promptId: "draft-email",
	version: 1,
	systemPrompt: "You are a professional email writer.",
	userPrompt: "Write a {tone} email about: {topic}",
	modelDefaults: { model: "claude-3-5-sonnet-20241022", temperature: 0.7 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [new AnthropicProvider(process.env.ANTHROPIC_API_KEY!)],
	promptRegistry: registry,
});

const result = await llm.callText({
	promptId: "draft-email",
	variables: { tone: "formal", topic: "Q3 budget review" },
});

console.log(result.text);
```

## What to change next

- Add multiple providers and let model-prefix routing pick between them automatically — see [07-providers-and-errors.md](../07-providers-and-errors.md).
- To test consumer code that uses `AnthropicProvider`, swap it out for a deterministic mock — see [custom-provider-mock-testing.md](./custom-provider-mock-testing.md).
