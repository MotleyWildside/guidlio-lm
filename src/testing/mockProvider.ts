import { vi } from "vitest";
import type {
	LLMProvider,
	LLMProviderRequest,
	LLMProviderResponse,
	LLMProviderStreamResponse,
	LLMProviderEmbedRequest,
	LLMProviderEmbedResponse,
	LLMProviderEmbedBatchRequest,
	LLMProviderEmbedBatchResponse,
} from "../llm-service/providers/types";

export type MockProviderOptions = {
	name?: string;
	supports?: (model: string) => boolean;
	callImpl?: (req: LLMProviderRequest) => Promise<LLMProviderResponse>;
	streamImpl?: (req: LLMProviderRequest) => Promise<LLMProviderStreamResponse>;
	embedImpl?: (req: LLMProviderEmbedRequest) => Promise<LLMProviderEmbedResponse>;
	embedBatchImpl?: (req: LLMProviderEmbedBatchRequest) => Promise<LLMProviderEmbedBatchResponse>;
};

export function makeMockProvider(options: MockProviderOptions = {}): LLMProvider {
	const name = options.name ?? "mock";
	const supportsFn = options.supports ?? (() => true);

	const defaultCallImpl = async (_req: LLMProviderRequest): Promise<LLMProviderResponse> => ({
		text: "mock response",
		raw: {},
		usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
		finishReason: "stop",
	});

	const defaultStreamImpl = async (
		_req: LLMProviderRequest,
	): Promise<LLMProviderStreamResponse> => ({
		stream: (async function* () {
			yield { text: "mock", delta: "mock" };
		})(),
	});

	const defaultEmbedImpl = async (
		_req: LLMProviderEmbedRequest,
	): Promise<LLMProviderEmbedResponse> => ({
		embedding: [0.1, 0.2, 0.3],
		usage: { totalTokens: 5 },
	});

	const defaultEmbedBatchImpl = async (
		req: LLMProviderEmbedBatchRequest,
	): Promise<LLMProviderEmbedBatchResponse> => ({
		embeddings: req.texts.map(() => [0.1, 0.2, 0.3]),
		usage: { totalTokens: req.texts.length * 5 },
	});

	return {
		name,
		call: vi.fn(options.callImpl ?? defaultCallImpl),
		callStream: vi.fn(options.streamImpl ?? defaultStreamImpl),
		embed: vi.fn(options.embedImpl ?? defaultEmbedImpl),
		embedBatch: vi.fn(options.embedBatchImpl ?? defaultEmbedBatchImpl),
		supportsModel: vi.fn(supportsFn),
	} as unknown as LLMProvider;
}
