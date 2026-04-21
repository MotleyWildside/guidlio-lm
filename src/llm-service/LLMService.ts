import { z } from "zod";
import { PromptRegistry } from "./prompts-registry/PromptRegistry";
import { OpenAIProvider } from "./providers/OpenAIProvider";
import { OpenRouterProvider } from "./providers/OpenRouterProvider";
import { GeminiProvider } from "./providers/GeminiProvider";
import type { LLMProvider } from "./providers/types";
import type { CacheProvider } from "./cache/types";
import { InMemoryCacheProvider } from "./cache/CacheProvider";
import { LLMTransientError, LLMParseError, LLMSchemaError } from "../errors";
import { createHash } from "crypto";
import type {
	LLMTextParams,
	LLMJsonParams,
	LLMTextResult,
	LLMJsonResult,
	LLMStreamResult,
	LLMEmbedParams,
	LLMEmbedResult,
	LLMEmbedBatchParams,
	LLMEmbedBatchResult,
	LLMServiceConfig,
	LLMLogger,
} from "../types";

/**
 * Main LLM Gateway Service
 */
export class LLMService {
	private providers: Map<string, LLMProvider> = new Map();
	private cache: CacheProvider;
	private promptReg: PromptRegistry;
	private logger: LLMLogger | null;

	constructor(private config: LLMServiceConfig) {
		// Validate providers
		if (!config.providers || config.providers.length === 0) {
			throw new Error(
				"At least one provider must be specified in LLMServiceConfig",
			);
		}

		// Initialize providers
		for (const provider of config.providers) {
			this.providers.set(provider.name, provider);
		}

		// Initialize cache
		this.cache = config.cacheProvider || new InMemoryCacheProvider();

		// Initialize prompt registry
		this.promptReg = config.promptRegistry || new PromptRegistry();

		// Initialize logger
		this.logger = config.logger || null;
	}

	/**
	 * Access the prompt registry to manage versioned prompts
	 */
	public get promptRegistry(): PromptRegistry {
		return this.promptReg;
	}

	/**
	 * Get provider for a given model (auto-selects based on model name)
	 */
	private getProvider(model: string): LLMProvider {
		// If default provider is specified, use it
		if (this.config.defaultProvider) {
			const provider = this.providers.get(this.config.defaultProvider);
			if (provider) {
				return provider;
			}
		}

		// Auto-select provider based on model support
		for (const provider of this.providers.values()) {
			if (provider.supportsModel(model)) {
				return provider;
			}
		}

		// Fallback to first available provider
		const firstProvider = Array.from(this.providers.values())[0];
		if (!firstProvider) {
			throw new Error("No LLM providers available");
		}

		return firstProvider;
	}

	/**
	 * Generate text response
	 */
	async callText(params: LLMTextParams): Promise<LLMTextResult> {
		const startTime = Date.now();
		const traceId = params.traceId || this.generateTraceId();
		let prompt: ReturnType<typeof this.promptReg.getPrompt> = null;

		try {
			// Get prompt from registry
			prompt = this.promptReg.getPrompt(
				params.promptId,
				params.promptVersion,
			);
			if (!prompt) {
				throw new Error(
					`Prompt not found: ${params.promptId}@${params.promptVersion || "latest"}`,
				);
			}

			// Build cache key
			const cacheKey = this.buildCacheKey(params, prompt);

			// Prepare provider request
			const model = params.model || prompt.modelDefaults.model;
			const provider = this.getProvider(model);

			// Check cache
			if (
				params.cache?.mode === "read_through" &&
				this.config.enableCache !== false
			) {
				const cached = await this.cache.get<LLMTextResult>(cacheKey);
				if (cached) {
					this.logCall({
						traceId,
						promptId: params.promptId,
						promptVersion: prompt.version,
						model: prompt.modelDefaults.model,
						provider: provider.name,
						success: true,
						cached: true,
						durationMs: Date.now() - startTime,
					});
					return { ...cached, traceId };
				}
			}

			// Build messages
			const messages = this.promptReg.buildMessages(
				prompt,
				params.variables,
			);
			const providerRequest = {
				messages,
				model,
				temperature:
					params.temperature ??
					prompt.modelDefaults.temperature ??
					this.config.defaultTemperature ??
					0.7,
				maxTokens: params.maxTokens ?? prompt.modelDefaults.maxTokens,
				topP: params.topP ?? prompt.modelDefaults.topP,
				seed: params.seed,
				responseFormat: "text" as const,
			};

			// Call provider with retries
			const response = await this.callWithRetries(
				() => provider.call(providerRequest),
				model,
				params.promptId,
				traceId,
				provider.name,
			);

			const result: LLMTextResult = {
				text: response.text,
				usage: response.usage,
				finishReason: response.finishReason,
				requestId: response.requestId,
				traceId,
				promptId: params.promptId,
				promptVersion: prompt.version,
				model,
				durationMs: Date.now() - startTime,
			};

			// Cache result (write for both 'read_through' and 'refresh' modes)
			if (
				(params.cache?.mode === "read_through" ||
					params.cache?.mode === "refresh") &&
				this.config.enableCache !== false &&
				params.cache.ttlSeconds
			) {
				await this.cache.set(cacheKey, result, params.cache.ttlSeconds);
			}

			this.logCall({
				traceId,
				promptId: params.promptId,
				promptVersion: prompt.version,
				model,
				provider: provider.name,
				success: true,
				usage: response.usage,
				durationMs: result.durationMs,
			});

			return result;
		} catch (error) {
			const durationMs = Date.now() - startTime;
			const modelForError =
				params.model || prompt?.modelDefaults?.model || "unknown";
			const providerForError =
				modelForError !== "unknown"
					? this.getProvider(modelForError)
					: null;

			this.logCall({
				traceId,
				promptId: params.promptId,
				promptVersion: params.promptVersion,
				model: modelForError,
				provider: providerForError?.name,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				durationMs,
			});

			throw error;
		}
	}

	/**
	 * Generate JSON response with schema validation
	 */
	async callJSON<T = unknown>(
		params: LLMJsonParams<T>,
	): Promise<LLMJsonResult<T>> {
		const startTime = Date.now();
		const traceId = params.traceId || this.generateTraceId();
		let prompt: ReturnType<typeof this.promptReg.getPrompt> = null;

		try {
			// Get prompt from registry
			prompt = this.promptReg.getPrompt(
				params.promptId,
				params.promptVersion,
			);
			if (!prompt) {
				throw new Error(
					`Prompt not found: ${params.promptId}@${params.promptVersion || "latest"}`,
				);
			}

			if (prompt.output.type !== "json") {
				throw new Error(
					`Prompt ${params.promptId} is not configured for JSON output`,
				);
			}

			// Build cache key
			const cacheKey = this.buildCacheKey(params, prompt);

			// Prepare provider request
			const model = params.model || prompt.modelDefaults.model;
			const provider = this.getProvider(model);

			// Check cache
			if (
				params.cache?.mode === "read_through" &&
				this.config.enableCache !== false
			) {
				const cached = await this.cache.get<LLMJsonResult<T>>(cacheKey);
				if (cached) {
					this.logCall({
						traceId,
						promptId: params.promptId,
						promptVersion: prompt.version,
						model: prompt.modelDefaults.model,
						provider: provider.name,
						success: true,
						cached: true,
						durationMs: Date.now() - startTime,
					});
					return { ...cached, traceId };
				}
			}

			// Build messages with JSON enforcement
			const messages = this.promptReg.buildMessages(
				prompt,
				params.variables,
			);

			// Ensure JSON mode is enforced in the last user message
			if (
				messages.length > 0 &&
				messages[messages.length - 1].role === "user"
			) {
				const lastMessage = messages[messages.length - 1];
				if (
					!lastMessage.content.includes("ONLY JSON") &&
					!lastMessage.content.includes("valid JSON") &&
					!lastMessage.content.includes("JSON format")
				) {
					messages[messages.length - 1] = {
						...lastMessage,
						content: `${lastMessage.content}\n\nIMPORTANT: Return ONLY valid JSON. No markdown, no code fences, no explanatory text.`,
					};
				}
			}

			// Prepare provider request (model and provider already set above)
			const providerRequest = {
				messages,
				model,
				temperature:
					params.temperature ??
					prompt.modelDefaults.temperature ??
					this.config.defaultTemperature ??
					0.7,
				maxTokens: params.maxTokens ?? prompt.modelDefaults.maxTokens,
				topP: params.topP ?? prompt.modelDefaults.topP,
				seed: params.seed,
				responseFormat: "json" as const,
			};

			// Call provider with retries
			const response = await this.callWithRetries(
				() => provider.call(providerRequest),
				model,
				params.promptId,
				traceId,
				provider.name,
			);

			// Parse and repair JSON
			let parsed: T;
			try {
				parsed = this.parseJSON<T>(response.text);
			} catch (parseError) {
				// Attempt one repair
				try {
					const repaired = this.repairJSON(response.text);
					parsed = JSON.parse(repaired) as T;
				} catch (repairError) {
					throw new LLMParseError(
						`Failed to parse JSON response: ${repairError instanceof Error ? repairError.message : String(repairError)}`,
						provider.name,
						model,
						response.text,
						params.promptId,
						response.requestId,
						parseError instanceof Error ? parseError : undefined,
					);
				}
			}

			// Validate schema if provided
			const schema = params.jsonSchema || prompt.output.schema;
			if (schema) {
				try {
					parsed = schema.parse(parsed);
				} catch (validationError) {
					if (validationError instanceof z.ZodError) {
						throw new LLMSchemaError(
							`Schema validation failed: ${validationError.message}`,
							provider.name,
							model,
							validationError.errors.map(
								(e) => `${e.path.join(".")}: ${e.message}`,
							),
							params.promptId,
							response.requestId,
							validationError,
						);
					}
					throw validationError;
				}
			}

			const result: LLMJsonResult<T> = {
				data: parsed,
				text: response.text,
				usage: response.usage,
				finishReason: response.finishReason,
				requestId: response.requestId,
				traceId,
				promptId: params.promptId,
				promptVersion: prompt.version,
				model,
				durationMs: Date.now() - startTime,
			};

			// Cache result (write for both 'read_through' and 'refresh' modes)
			if (
				(params.cache?.mode === "read_through" ||
					params.cache?.mode === "refresh") &&
				this.config.enableCache !== false &&
				params.cache.ttlSeconds
			) {
				await this.cache.set(cacheKey, result, params.cache.ttlSeconds);
			}

			this.logCall({
				traceId,
				promptId: params.promptId,
				promptVersion: prompt.version,
				model,
				provider: provider.name,
				success: true,
				usage: response.usage,
				durationMs: result.durationMs,
			});

			return result;
		} catch (error) {
			const durationMs = Date.now() - startTime;
			const modelForError =
				params.model || prompt?.modelDefaults?.model || "unknown";
			const providerForError =
				modelForError !== "unknown"
					? this.getProvider(modelForError)
					: null;

			this.logCall({
				traceId,
				promptId: params.promptId,
				promptVersion: params.promptVersion,
				model: modelForError,
				provider: providerForError?.name,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				durationMs,
			});

			throw error;
		}
	}

	/**
	 * Generate streaming response
	 */
	async callStream(params: LLMTextParams): Promise<LLMStreamResult> {
		const traceId = params.traceId || this.generateTraceId();
		let prompt: ReturnType<typeof this.promptReg.getPrompt> = null;

		try {
			// Get prompt from registry
			prompt = this.promptReg.getPrompt(
				params.promptId,
				params.promptVersion,
			);
			if (!prompt) {
				throw new Error(
					`Prompt not found: ${params.promptId}@${params.promptVersion || "latest"}`,
				);
			}

			// Prepare provider request
			const model = params.model || prompt.modelDefaults.model;
			const provider = this.getProvider(model);

			// Build messages
			const messages = this.promptReg.buildMessages(
				prompt,
				params.variables,
			);
			const providerRequest = {
				messages,
				model,
				temperature:
					params.temperature ??
					prompt.modelDefaults.temperature ??
					this.config.defaultTemperature ??
					0.7,
				maxTokens: params.maxTokens ?? prompt.modelDefaults.maxTokens,
				topP: params.topP ?? prompt.modelDefaults.topP,
				seed: params.seed,
				responseFormat: "text" as const,
			};

			// Call provider
			const response = await provider.callStream(providerRequest);

			return {
				stream: response.stream,
				traceId,
				promptId: params.promptId,
				promptVersion: prompt.version,
				model,
			};
		} catch (error) {
			this.logCall({
				traceId,
				promptId: params.promptId,
				promptVersion: params.promptVersion,
				model: "unknown",
				success: false,
				error: error instanceof Error ? error.message : String(error),
				durationMs: 0,
			});

			throw error;
		}
	}

	/**
	 * Call provider with exponential backoff retries
	 */
	private async callWithRetries<T>(
		fn: () => Promise<T>,
		model: string,
		promptId?: string,
		traceId?: string,
		providerName?: string,
	): Promise<T> {
		const maxRetries = this.config.maxRetries ?? 3;
		const baseDelay = this.config.retryBaseDelayMs ?? 1000;

		let lastError: Error | undefined;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				return await fn();
			} catch (error) {
				lastError =
					error instanceof Error ? error : new Error(String(error));

				// Only retry transient errors
				if (!(error instanceof LLMTransientError)) {
					throw error;
				}

				// Don't retry on last attempt
				if (attempt === maxRetries - 1) {
					throw error;
				}

				// Calculate delay with exponential backoff and jitter
				const delay =
					baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
				await this.sleep(delay);

				this.logCall({
					traceId,
					promptId,
					model,
					provider: providerName,
					success: false,
					error: `Retry attempt ${attempt + 1}/${maxRetries}: ${lastError.message}`,
					retry: true,
					durationMs: 0,
				});
			}
		}

		throw lastError || new Error("Unknown error in retry loop");
	}

	/**
	 * Parse JSON with error handling
	 */
	private parseJSON<T>(text: string): T {
		try {
			return JSON.parse(text) as T;
		} catch (error) {
			throw new Error(
				`JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Repair JSON by stripping markdown fences and trimming
	 */
	private repairJSON(text: string): string {
		// Remove markdown code fences
		let repaired = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
		repaired = repaired.replace(/\s*```\s*$/i, "");

		// Find first { and last }
		const firstBrace = repaired.indexOf("{");
		const lastBrace = repaired.lastIndexOf("}");

		if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
			repaired = repaired.substring(firstBrace, lastBrace + 1);
		}

		return repaired.trim();
	}

	/**
	 * Build cache key from params
	 */
	private buildCacheKey(
		params: LLMTextParams | LLMJsonParams,
		prompt: { promptId: string; version: string | number },
	): string {
		const keyParts = [
			params.idempotencyKey || "",
			prompt.promptId,
			String(prompt.version),
			JSON.stringify(params.variables || {}),
			params.model || "",
			String(params.temperature || ""),
		];

		const keyString = keyParts.join("|");
		return createHash("sha256").update(keyString).digest("hex");
	}

	/**
	 * Generate trace ID
	 */
	private generateTraceId(): string {
		return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	}

	/**
	 * Generate vector embedding for text
	 */
	async embed(params: LLMEmbedParams): Promise<LLMEmbedResult> {
		const traceId = this.generateTraceId();
		const startTime = Date.now();

		try {
			const model = params.model;
			const provider = this.getProvider(model);

			const response = await provider.embed({
				text: params.text,
				model,
				dimensions: params.dimensions,
				taskType: params.taskType,
			});

			this.logCall({
				traceId,
				model,
				provider: provider.name,
				success: true,
				durationMs: Date.now() - startTime,
			});

			return {
				embedding: response.embedding,
				usage: response.usage,
				model,
			};
		} catch (error) {
			this.logCall({
				traceId,
				model: params.model,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startTime,
			});

			throw error;
		}
	}

	/**
	 * Generate vector embeddings for multiple texts
	 */
	async embedBatch(
		params: LLMEmbedBatchParams,
	): Promise<LLMEmbedBatchResult> {
		const traceId = this.generateTraceId();
		const startTime = Date.now();

		try {
			const model = params.model;
			const provider = this.getProvider(model);

			const response = await provider.embedBatch({
				texts: params.texts,
				model,
				dimensions: params.dimensions,
				taskType: params.taskType,
			});

			this.logCall({
				traceId,
				model,
				provider: provider.name,
				success: true,
				durationMs: Date.now() - startTime,
			});

			return {
				embeddings: response.embeddings,
				usage: response.usage,
				model,
			};
		} catch (error) {
			this.logCall({
				traceId,
				model: params.model,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startTime,
			});

			throw error;
		}
	}

	/**
	 * structured logging with fancy formatting
	 */
	private logCall(log: {
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
	}): void {
		if (this.logger) {
			this.logger.llmCall(log);
		}
	}

	/**
	 * Sleep utility
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
