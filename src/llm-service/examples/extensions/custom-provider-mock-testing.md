# Custom Provider — Deterministic Mock for Consumer Tests

When you write integration tests for code that calls `GuidlioLMService`, you want fully deterministic responses without making real API calls. `MockLLMProvider` is a scriptable in-process provider you own and ship alongside your consumer code — distinct from the internal `makeMockProvider` fixture that the `guidlio-lm` library uses for its own unit tests. This provider lets you assert on the exact messages the service sent, simulate transient failures, test retry logic, and verify caching behaviour.

## Concepts covered

- Implementing `LLMProvider` as a scriptable test double
- Queueing deterministic `LLMProviderResponse` values with `queue()`
- Recording all `ProviderRequest` arguments in `calls[]` for post-call assertions
- Streaming queued text character-by-character via `callStream()`
- Injecting transient failures before a success with `simulateTransientError(n)`
- Returning zero-vectors for `embed()` / `embedBatch()` with configurable dimensions
- Using the mock inside a Vitest test to verify caching behaviour

## The mock provider

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
import { LLMTransientError } from "guidlio-lm";

export class MockLLMProvider implements LLMProvider {
	readonly name = "mock";

	// Every call is recorded here for post-call assertions
	calls: ProviderRequest[] = [];

	// Embed calls are recorded separately so tests can assert on them independently
	embedCalls: LLMEmbedRequest[] = [];

	private responseQueue: LLMProviderResponse[] = [];
	private transientErrorsRemaining = 0;
	private embeddingDimensions: number;

	constructor({ embeddingDimensions = 1536 }: { embeddingDimensions?: number } = {}) {
		this.embeddingDimensions = embeddingDimensions;
	}

	// Script the next N responses. Calls dequeue in FIFO order.
	queue(responses: Partial<LLMProviderResponse>[]): this {
		for (const r of responses) {
			this.responseQueue.push({
				text: r.text ?? "",
				usage: r.usage ?? { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
				finishReason: r.finishReason ?? "stop",
				requestId: r.requestId,
			});
		}
		return this;
	}

	// Make the next `n` calls fail with LLMTransientError before succeeding.
	// Useful for testing retry logic in GuidlioLMService.
	simulateTransientError(n: number): this {
		this.transientErrorsRemaining = n;
		return this;
	}

	// Reset all state between tests
	reset(): this {
		this.calls = [];
		this.embedCalls = [];
		this.responseQueue = [];
		this.transientErrorsRemaining = 0;
		return this;
	}

	supportsModel(_model: string): boolean {
		// The mock handles every model so the service never falls back to a real provider
		return true;
	}

	async call(request: ProviderRequest): Promise<LLMProviderResponse> {
		this.calls.push(request);

		if (this.transientErrorsRemaining > 0) {
			this.transientErrorsRemaining--;
			throw new LLMTransientError("Simulated transient error", {
				provider: this.name,
				model: request.model,
				statusCode: 429,
			});
		}

		const next = this.responseQueue.shift();
		if (!next) {
			throw new Error(
				`MockLLMProvider: call() invoked but the response queue is empty. ` +
					`Did you forget to call mock.queue([...])?`,
			);
		}

		return next;
	}

	async callStream(request: ProviderRequest): Promise<LLMProviderStreamResponse> {
		this.calls.push(request);

		const next = this.responseQueue.shift();
		if (!next) {
			throw new Error(
				`MockLLMProvider: callStream() invoked but the response queue is empty.`,
			);
		}

		const fullText = next.text;
		let accumulatedText = "";

		// Stream the queued text character by character
		const stream: AsyncIterable<{ text: string; delta: string }> = {
			[Symbol.asyncIterator]() {
				return (async function* () {
					for (const char of fullText) {
						accumulatedText += char;
						yield { text: accumulatedText, delta: char };
					}
				})();
			},
		};

		return { stream };
	}

	async embed(request: LLMEmbedRequest): Promise<LLMEmbedResponse> {
		this.embedCalls.push(request);
		return {
			embedding: new Array(this.embeddingDimensions).fill(0),
			usage: { totalTokens: 5 },
		};
	}

	async embedBatch(request: LLMEmbedBatchRequest): Promise<LLMEmbedBatchResponse> {
		// Record as individual embed calls so assertions stay simple
		for (const text of request.texts) {
			this.embedCalls.push({ ...request, text });
		}
		return {
			embeddings: request.texts.map(() => new Array(this.embeddingDimensions).fill(0)),
			usage: { totalTokens: request.texts.length * 5 },
		};
	}
}
```

## Using the mock in Vitest tests

### Assert on messages sent to the provider

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { GuidlioLMService, PromptRegistry } from "guidlio-lm";
import { MockLLMProvider } from "./MockLLMProvider";

describe("summarise pipeline", () => {
	let mock: MockLLMProvider;
	let llm: GuidlioLMService;

	beforeEach(() => {
		const registry = new PromptRegistry();
		registry.register({
			promptId: "summarize",
			version: 1,
			systemPrompt: "You are a concise summarizer.",
			userPrompt: "Summarize: {text}",
			modelDefaults: { model: "mock-model", temperature: 0 },
			output: { type: "text" },
		});

		mock = new MockLLMProvider();
		llm = new GuidlioLMService({ providers: [mock], promptRegistry: registry });
	});

	it("sends the interpolated user message to the provider", async () => {
		mock.queue([{ text: "A short summary." }]);

		await llm.callText({ promptId: "summarize", variables: { text: "A long article..." } });

		expect(mock.calls).toHaveLength(1);
		// Verify variable interpolation happened before the provider was called
		const userMessage = mock.calls[0].messages.find((m) => m.role === "user");
		expect(userMessage?.content).toBe("Summarize: A long article...");
	});

	it("returns the text from the provider response", async () => {
		mock.queue([{ text: "Summary result." }]);

		const result = await llm.callText({
			promptId: "summarize",
			variables: { text: "Some text." },
		});

		expect(result.text).toBe("Summary result.");
	});
});
```

### Verify that caching prevents a second provider call

```typescript
import { GuidlioLMService, PromptRegistry, InMemoryCacheProvider } from "guidlio-lm";

it("cache hit skips the provider on the second call", async () => {
	const registry = new PromptRegistry();
	registry.register({
		promptId: "greet",
		version: 1,
		userPrompt: "Hello, {name}!",
		modelDefaults: { model: "mock-model", temperature: 0 },
		output: { type: "text" },
	});

	const mock = new MockLLMProvider();
	// Queue only one response — a second provider call would throw (empty queue)
	mock.queue([{ text: "Hello, world!" }]);

	const llm = new GuidlioLMService({
		providers: [mock],
		promptRegistry: registry,
		cacheProvider: new InMemoryCacheProvider(),
	});

	const params = {
		promptId: "greet",
		variables: { name: "world" },
		cache: { mode: "read_through" as const, ttlSeconds: 60 },
	};

	const first = await llm.callText(params);
	const second = await llm.callText(params); // served from cache

	expect(mock.calls).toHaveLength(1); // provider was called exactly once
	expect(first.text).toBe(second.text);
});
```

### Test retry behaviour

```typescript
it("retries on transient errors and eventually succeeds", async () => {
	const registry = new PromptRegistry();
	registry.register({
		promptId: "p",
		version: 1,
		userPrompt: "Hello",
		modelDefaults: { model: "mock-model", temperature: 0 },
		output: { type: "text" },
	});

	const mock = new MockLLMProvider();
	// Fail twice then succeed on the third attempt
	mock.simulateTransientError(2);
	mock.queue([{ text: "Success after retries." }]);

	const llm = new GuidlioLMService({
		providers: [mock],
		promptRegistry: registry,
		maxAttempts: 3,
		retryBaseDelayMs: 0, // remove delay in tests
	});

	const result = await llm.callText({ promptId: "p", variables: {} });

	expect(result.text).toBe("Success after retries.");
	// 2 failed attempts + 1 success = 3 total calls
	expect(mock.calls).toHaveLength(3);
});
```

## Distinction from `makeMockProvider`

`makeMockProvider` (in `tests/fixtures/`) is a factory used by `guidlio-lm`'s own internal test suite. It is not part of the public API and may change between releases. `MockLLMProvider` above is code you own in your consumer project — import it from your own source tree, not from `guidlio-lm`.

## What to change next

- Build a real provider for Anthropic that this mock can stand in for — see [custom-provider-anthropic.md](./custom-provider-anthropic.md).
- Add caching to your service setup and verify behaviour with the mock — see [06-caching.md](../06-caching.md).
