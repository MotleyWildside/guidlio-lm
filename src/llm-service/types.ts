import { z } from "zod";
import type { LLMProvider } from "./providers/types";
import type { CacheProvider, CacheConfig } from "./cache/types";
import { PromptRegistry } from "./prompts-registry/PromptRegistry";
import type { LLMLogger } from "../logger/types";
export type { LLMCallLogEntry } from "../logger/types";

/**
 * Parameters for text generation
 */
export interface LLMTextParams {
	promptId: string;
	promptVersion?: string | number;
	variables?: Record<string, unknown>;
	model?: string;
	temperature?: number;
	maxTokens?: number;
	topP?: number;
	seed?: number;
	idempotencyKey?: string;
	cache?: CacheConfig;
	traceId?: string;
}

/**
 * Parameters for JSON generation
 */
export interface LLMJsonParams<T = unknown> extends LLMTextParams {
	jsonSchema?: z.ZodSchema<T>;
}

/**
 * Parameters for embedding generation
 */
export interface LLMEmbedParams {
	text: string;
	model: string;
	dimensions?: number;
	taskType?: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";
}

/**
 * Parameters for batch embedding generation
 */
export interface LLMEmbedBatchParams {
	texts: string[];
	model: string;
	dimensions?: number;
	taskType?: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";
}

/**
 * Result from text generation
 */
export interface LLMTextResult {
	text: string;
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
	finishReason?: string;
	requestId?: string;
	traceId: string;
	promptId: string;
	promptVersion: string | number;
	model: string;
	durationMs: number;
}

/**
 * Result from streaming generation
 */
export interface LLMStreamResult {
	stream: AsyncIterable<{
		text: string;
		delta: string;
	}>;
	traceId: string;
	promptId: string;
	promptVersion: string | number;
	model: string;
}

/**
 * Result from JSON generation
 */
export interface LLMJsonResult<T = unknown> extends LLMTextResult {
	data: T;
}

/**
 * Result from embedding generation
 */
export interface LLMEmbedResult {
	embedding: number[];
	usage?: {
		totalTokens: number;
	};
	model: string;
}

/**
 * Result from batch embedding generation
 */
export interface LLMEmbedBatchResult {
	embeddings: number[][];
	usage?: {
		totalTokens: number;
	};
	model: string;
}

/**
 * Normalized request shape passed to a provider
 */
export interface ProviderRequest {
	messages: ReturnType<PromptRegistry["buildMessages"]>;
	model: string;
	temperature: number;
	maxTokens?: number;
	topP?: number;
	seed?: number;
	responseFormat: "text" | "json";
}

/**
 * Resolved call context shared across callText / callJSON / callStream
 */
export interface ResolvedCall {
	prompt: NonNullable<ReturnType<PromptRegistry["getPrompt"]>>;
	model: string;
	provider: LLMProvider;
	cacheKey: string;
}

/**
 * Configuration for LLMService
 */
export interface LLMServiceConfig {
	/**
	 * List of available providers (required)
	 */
	providers: LLMProvider[];
	/**
	 * Default provider name to use (if not specified, auto-selects based on model)
	 */
	defaultProvider?: string;
	defaultModel?: string;
	defaultTemperature?: number;
	maxRetries?: number;
	retryBaseDelayMs?: number;
	enableCache?: boolean;
	cacheProvider?: CacheProvider;
	promptRegistry?: PromptRegistry;
	logger?: LLMLogger;
}
