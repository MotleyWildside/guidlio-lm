# Testing Consumer Code

Testing code that uses `guidlio-lm` without hitting real provider APIs. The approach is to inject a `MockLLMProvider` that returns scripted responses, combined with `InMemoryCacheProvider` for cache behavior tests and `enableCache: false` for tests that don't care about caching.

**Concepts covered:**
- A `MockLLMProvider` that queues scripted responses and records calls
- Injecting `LLMTransientError` to test retry behavior
- Asserting on prompt variables via `mock.calls`
- Verifying cache hits by counting provider invocations
- Test setup conventions for isolation

---

## The mock provider

Put this in a shared test helper file (e.g., `tests/helpers/MockLLMProvider.ts`):

```typescript
import {
	LLMProvider,
	LLMTransientError,
	ProviderRequest,
} from "guidlio-lm";

type MockResponse = {
	text?: string;
	usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
	requestId?: string;
};

export class MockLLMProvider implements LLMProvider {
	readonly name = "mock";
	private queue: MockResponse[] = [];
	private transientCount = 0;
	readonly calls: ProviderRequest[] = [];

	/** Queue one or more scripted responses (dequeued in order). */
	queue(responses: MockResponse[]): this {
		this.queue.push(...responses);
		return this;
	}

	/** Inject N transient errors before the next queued response succeeds. */
	simulateTransientError(count: number): this {
		this.transientCount = count;
		return this;
	}

	supportsModel(_model: string): boolean {
		return true; // accepts everything
	}

	async call(request: ProviderRequest): Promise<{
		text: string;
		usage?: MockResponse["usage"];
		finishReason?: string;
		requestId?: string;
	}> {
		this.calls.push(request);

		if (this.transientCount > 0) {
			this.transientCount--;
			throw new LLMTransientError("mock transient error", "mock", request.model, undefined, undefined, 503);
		}

		const next = this.queue.shift();
		if (!next) throw new Error("MockLLMProvider: response queue is empty");
		return { text: next.text ?? "", usage: next.usage, requestId: next.requestId };
	}

	async callStream(request: ProviderRequest): Promise<{ stream: AsyncIterable<{ text: string; delta: string }> }> {
		const response = await this.call(request);
		const chars = response.text.split("");
		let accumulated = "";
		async function* gen() {
			for (const ch of chars) {
				accumulated += ch;
				yield { text: accumulated, delta: ch };
			}
		}
		return { stream: gen() };
	}

	async embed(_request: { text: string; model: string }): Promise<{ embedding: number[]; usage?: { totalTokens: number } }> {
		return { embedding: new Array(1536).fill(0) };
	}

	async embedBatch(request: { texts: string[]; model: string }): Promise<{ embeddings: number[][]; usage?: { totalTokens: number } }> {
		return { embeddings: request.texts.map(() => new Array(1536).fill(0)) };
	}
}
```

---

## The service under test

A simple `SummarizeService` that wraps `GuidlioLMService`:

```typescript
// src/SummarizeService.ts
import { GuidlioLMService, LLMTextResult } from "guidlio-lm";

export class SummarizeService {
	constructor(private llm: GuidlioLMService) {}

	async summarize(text: string, traceId: string): Promise<string> {
		const result = await this.llm.callText({
			promptId: "summarize",
			variables: { text },
			traceId,
		});
		return result.text;
	}
}
```

---

## Test suite

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { GuidlioLMService, PromptRegistry, InMemoryCacheProvider } from "guidlio-lm";
import { MockLLMProvider } from "./helpers/MockLLMProvider";
import { SummarizeService } from "../src/SummarizeService";

function makeRegistry(): PromptRegistry {
	const registry = new PromptRegistry();
	registry.register({
		promptId: "summarize",
		version: 1,
		systemPrompt: "Summarize the given text concisely.",
		userPrompt: "Text: {text}",
		modelDefaults: { model: "mock-model", temperature: 0 },
		output: { type: "text" },
	});
	return registry;
}

describe("SummarizeService", () => {
	let mock: MockLLMProvider;
	let service: SummarizeService;

	beforeEach(() => {
		mock = new MockLLMProvider();
		const llm = new GuidlioLMService({
			providers: [mock],
			promptRegistry: makeRegistry(),
			enableCache: false, // isolate from cache in non-cache tests
		});
		service = new SummarizeService(llm);
	});

	it("returns the provider response", async () => {
		mock.queue([{ text: "This is a summary." }]);

		const result = await service.summarize("A long article...", "trace-001");

		expect(result).toBe("This is a summary.");
	});

	it("passes the input text as a prompt variable", async () => {
		mock.queue([{ text: "Summary." }]);

		await service.summarize("My input text", "trace-001");

		// The user message is the second message (index 1)
		const userMessage = mock.calls[0].messages[1].content;
		expect(userMessage).toContain("My input text");
	});

	it("retries once on a transient error and succeeds", async () => {
		// 1 transient error, then success
		mock.simulateTransientError(1);
		mock.queue([{ text: "Recovered summary." }]);

		const llm = new GuidlioLMService({
			providers: [mock],
			promptRegistry: makeRegistry(),
			maxAttempts: 2,        // allow 1 retry
			retryBaseDelayMs: 0,   // no delay in tests
			enableCache: false,
		});
		const svc = new SummarizeService(llm);

		const result = await svc.summarize("text", "trace-002");
		expect(result).toBe("Recovered summary.");
		expect(mock.calls.length).toBe(2); // first attempt + 1 retry
	});

	it("serves from cache on second call with matching idempotencyKey", async () => {
		// Only one provider response queued — if it's called twice, the second call
		// throws "queue is empty". Passing the test confirms the second call was cached.
		mock.queue([{ text: "Cached summary." }]);

		const cache = new InMemoryCacheProvider();
		const llm = new GuidlioLMService({
			providers: [mock],
			promptRegistry: makeRegistry(),
			cacheProvider: cache,
		});

		const params = {
			promptId: "summarize",
			variables: { text: "Same text" },
			idempotencyKey: "article:42",
			cache: { mode: "read_through" as const, ttlSeconds: 60 },
		};

		await llm.callText(params);
		await llm.callText(params); // must not call the provider

		expect(mock.calls.length).toBe(1); // provider called only once
	});
});
```

---

## Tips

**`enableCache: false` in non-cache tests** — prevents one test's cache writes from leaking into another's reads. Create a fresh `InMemoryCacheProvider` instance per test if you do need caching.

**`retryBaseDelayMs: 0` in retry tests** — avoids real timer delays in the test suite. The retry logic still executes; only the sleep is skipped.

**Assert on `mock.calls[n].messages`** — the messages array is the normalized form of your prompt after variable interpolation. Use it to verify variables, system prompts, and multi-turn history.

**Use `simulateTransientError(n)` to test exhaustion** — set `maxAttempts: 2` and `simulateTransientError(2)` to verify the service throws `LLMTransientError` after retries are exhausted.

---

## What to change next

- [custom-provider-mock-testing.md](../src/llm-service/examples/extensions/custom-provider-mock-testing.md) — the full `MockLLMProvider` with additional capabilities (delay injection, per-call scripting)
- [11-retry-tuning.md](../src/llm-service/examples/11-retry-tuning.md) — `maxAttempts`, `retryBaseDelayMs`, and retry behavior
