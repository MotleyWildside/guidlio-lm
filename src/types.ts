import { z } from "zod";
import type { LLMProvider } from "./llm-service/providers/types";
import type { CacheProvider } from "./llm-service/cache/types";
import { PromptRegistry } from "./llm-service/prompts-registry/PromptRegistry";

/**
 * Cache configuration
 */
export interface CacheConfig {
	/**
	 * Cache mode behavior:
	 * - 'read_through': Checks cache first, returns cached value if found. If not found, calls LLM and caches the result.
	 *   Use this for normal caching behavior to reduce API calls and improve response times.
	 * - 'bypass': Skips cache entirely - neither reads from nor writes to cache. Always calls LLM.
	 *   Use this when you need fresh results or want to avoid caching for sensitive/unique requests.
	 * - 'refresh': Bypasses cache read but still writes the new result to cache (forces refresh of cached value).
	 *   Use this when you want to update stale cache entries while still benefiting from future cache hits.
	 */
	mode: "read_through" | "bypass" | "refresh";
	/**
	 * Time-to-live in seconds for cached entries. Only used when mode is 'read_through' or 'refresh'.
	 * If not specified, cached entries will not expire.
	 */
	ttlSeconds?: number;
}

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
 * Interface for LLM Service logging
 */
export interface LLMLogger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, error?: unknown): void;
	debug(message: string, ...args: unknown[]): void;
	llmCall(log: {
		traceId?: string;
		promptId?: string;
		promptVersion?: string | number;
		model?: string;
		provider?: string;
		success: boolean;
		error?: string;
		usage?: {
			promptTokens: number;
			completionTokens: number;
			totalTokens: number;
		};
		cached?: boolean;
		retry?: boolean;
		durationMs: number;
	}): void;
	pipelineEvent(log: {
		event: string;
		traceId: string;
		stepName?: string;
		attempt?: number;
		outcome?: string;
		durationMs?: number;
		error?: Error;
	}): void;
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
