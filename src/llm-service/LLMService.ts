import { z } from "zod";
import { createHash, randomUUID } from "crypto";
import { PromptRegistry } from "./prompts-registry/PromptRegistry";
import type { LLMProvider } from "./providers/types";
import type { CacheProvider } from "./cache/types";
import { InMemoryCacheProvider } from "./cache/CacheProvider";
import { LLMTransientError, LLMParseError, LLMSchemaError } from "./errors";
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
	LLMCallLogEntry,
	ProviderRequest,
	ResolvedCall,
} from "./types";
import type { LLMLogger } from "../logger/types";

// ──────────────────────────────────────────────────────────────────────────────

/**
 * Main LLM Gateway Service
 */
export class LLMService {
	private providers: Map<string, LLMProvider> = new Map();
	private cache: CacheProvider;
	private promptReg: PromptRegistry;
	private logger: LLMLogger | null;

	constructor(private config: LLMServiceConfig) {
		if (!config.providers || config.providers.length === 0) {
			throw new Error(
				"At least one provider must be specified in LLMServiceConfig",
			);
		}

		for (const provider of config.providers) {
			this.providers.set(provider.name, provider);
		}

		this.cache = config.cacheProvider || new InMemoryCacheProvider();
		this.promptReg = config.promptRegistry || new PromptRegistry();
		this.logger = config.logger || null;
	}

	/**
	 * Access the prompt registry to manage versioned prompts
	 */
	public get promptRegistry(): PromptRegistry {
		return this.promptReg;
	}

	// ─── Provider selection ──────────────────────────────────────────────────

	/**
	 * Get provider for a given model (auto-selects based on model name).
	 * Falls back to auto-selection with a warning if defaultProvider is configured but missing.
	 */
	private getProvider(model: string): LLMProvider {
		if (this.config.defaultProvider) {
			const provider = this.providers.get(this.config.defaultProvider);
			if (provider) return provider;

			// Warn instead of silently ignoring a misconfiguration
			this.logCall({
				model,
				success: false,
				error: `Default provider "${this.config.defaultProvider}" not found — falling back to auto-select`,
				durationMs: 0,
			});
		}

		for (const provider of this.providers.values()) {
			if (provider.supportsModel(model)) return provider;
		}

		const firstProvider = Array.from(this.providers.values())[0];
		if (!firstProvider) {
			throw new Error("No LLM providers available");
		}

		return firstProvider;
	}

	// ─── Public API ──────────────────────────────────────────────────────────

	/**
	 * Generate text response
	 */
	async callText(params: LLMTextParams): Promise<LLMTextResult> {
		const startTime = Date.now();
		const traceId = params.traceId || this.generateTraceId();
		const { prompt, model, provider, cacheKey } = this.resolveCall(params);

		// Cache read
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
					model,
					provider: provider.name,
					success: true,
					cached: true,
					durationMs: Date.now() - startTime,
				});
				return { ...cached, traceId };
			}
		}

		const messages = this.promptReg.buildMessages(prompt, params.variables);
		const providerRequest = this.buildProviderRequest(
			params,
			prompt,
			model,
			messages,
			"text",
		);

		try {
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

			await this.writeCache(params, cacheKey, result);

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
			this.logCall({
				traceId,
				promptId: params.promptId,
				promptVersion: prompt.version,
				model,
				provider: provider.name,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startTime,
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
		const { prompt, model, provider, cacheKey } = this.resolveCall(params);

		if (prompt.output.type !== "json") {
			throw new Error(
				`Prompt ${params.promptId} is not configured for JSON output`,
			);
		}

		// Cache read
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
					model,
					provider: provider.name,
					success: true,
					cached: true,
					durationMs: Date.now() - startTime,
				});
				return { ...cached, traceId };
			}
		}

		const messages = this.promptReg.buildMessages(prompt, params.variables);
		this.enforceJsonInstruction(messages);

		const providerRequest = this.buildProviderRequest(
			params,
			prompt,
			model,
			messages,
			"json",
		);

		try {
			const response = await this.callWithRetries(
				() => provider.call(providerRequest),
				model,
				params.promptId,
				traceId,
				provider.name,
			);

			const parsed = this.parseAndRepairJSON<T>(
				response.text,
				provider.name,
				model,
				params.promptId,
				response.requestId,
			);

			const schema = params.jsonSchema || prompt.output.schema;
			const validated = this.validateSchema<T>(
				parsed,
				schema,
				provider.name,
				model,
				params.promptId,
				response.requestId,
			);

			const result: LLMJsonResult<T> = {
				data: validated,
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

			await this.writeCache(params, cacheKey, result);

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
			this.logCall({
				traceId,
				promptId: params.promptId,
				promptVersion: prompt.version,
				model,
				provider: provider.name,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startTime,
			});
			throw error;
		}
	}

	/**
	 * Generate streaming response.
	 * Note: streaming bypasses retry logic — handle reconnection at the call site if needed.
	 */
	async callStream(params: LLMTextParams): Promise<LLMStreamResult> {
		const traceId = params.traceId || this.generateTraceId();
		const { prompt, model, provider } = this.resolveCall(params);

		const messages = this.promptReg.buildMessages(prompt, params.variables);
		const providerRequest = this.buildProviderRequest(
			params,
			prompt,
			model,
			messages,
			"text",
		);

		try {
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
				promptVersion: prompt.version,
				model,
				provider: provider.name,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				durationMs: 0,
			});
			throw error;
		}
	}

	/**
	 * Generate vector embedding for text
	 */
	async embed(params: LLMEmbedParams): Promise<LLMEmbedResult> {
		const traceId = this.generateTraceId();
		const startTime = Date.now();
		const provider = this.getProvider(params.model);

		try {
			const response = await provider.embed({
				text: params.text,
				model: params.model,
				dimensions: params.dimensions,
				taskType: params.taskType,
			});

			this.logCall({
				traceId,
				model: params.model,
				provider: provider.name,
				success: true,
				durationMs: Date.now() - startTime,
			});

			return {
				embedding: response.embedding,
				usage: response.usage,
				model: params.model,
			};
		} catch (error) {
			this.logCall({
				traceId,
				model: params.model,
				provider: provider.name,
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
	async embedBatch(params: LLMEmbedBatchParams): Promise<LLMEmbedBatchResult> {
		const traceId = this.generateTraceId();
		const startTime = Date.now();
		const provider = this.getProvider(params.model);

		try {
			const response = await provider.embedBatch({
				texts: params.texts,
				model: params.model,
				dimensions: params.dimensions,
				taskType: params.taskType,
			});

			this.logCall({
				traceId,
				model: params.model,
				provider: provider.name,
				success: true,
				durationMs: Date.now() - startTime,
			});

			return {
				embeddings: response.embeddings,
				usage: response.usage,
				model: params.model,
			};
		} catch (error) {
			this.logCall({
				traceId,
				model: params.model,
				provider: provider.name,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startTime,
			});
			throw error;
		}
	}

	// ─── Private pipeline helpers ────────────────────────────────────────────

	/**
	 * Resolve prompt, model, provider and cache key — shared by all call* methods.
	 * Throws early with a clear message if the prompt does not exist.
	 */
	private resolveCall(params: LLMTextParams): ResolvedCall {
		const prompt = this.promptReg.getPrompt(
			params.promptId,
			params.promptVersion,
		);

		if (!prompt) {
			throw new Error(
				`Prompt not found: ${params.promptId}@${params.promptVersion ?? "latest"}`,
			);
		}

		const model = params.model || prompt.modelDefaults.model;
		const provider = this.getProvider(model);
		const cacheKey = this.buildCacheKey(params, prompt);

		return { prompt, model, provider, cacheKey };
	}

	/**
	 * Build a normalized provider request — shared by callText, callJSON, callStream
	 */
	private buildProviderRequest(
		params: LLMTextParams,
		prompt: NonNullable<ReturnType<PromptRegistry["getPrompt"]>>,
		model: string,
		messages: ReturnType<PromptRegistry["buildMessages"]>,
		responseFormat: "text" | "json",
	): ProviderRequest {
		return {
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
			responseFormat,
		};
	}

	/**
	 * Write a result to cache when the cache mode and TTL are configured
	 */
	private async writeCache(
		params: LLMTextParams,
		cacheKey: string,
		result: unknown,
	): Promise<void> {
		if (
			(params.cache?.mode === "read_through" ||
				params.cache?.mode === "refresh") &&
			this.config.enableCache !== false &&
			params.cache.ttlSeconds
		) {
			await this.cache.set(cacheKey, result, params.cache.ttlSeconds);
		}
	}

	/**
	 * Append a JSON-only instruction to the last user message if not already present.
	 * Mutates the messages array in place.
	 */
	private enforceJsonInstruction(
		messages: ReturnType<PromptRegistry["buildMessages"]>,
	): void {
		if (messages.length === 0) return;

		const last = messages[messages.length - 1];
		if (last.role !== "user") return;

		const alreadyInstructed =
			last.content.includes("ONLY JSON") ||
			last.content.includes("valid JSON") ||
			last.content.includes("JSON format");

		if (!alreadyInstructed) {
			messages[messages.length - 1] = {
				...last,
				content: `${last.content}\n\nIMPORTANT: Return ONLY valid JSON. No markdown, no code fences, no explanatory text.`,
			};
		}
	}

	/**
	 * Parse raw text as JSON; attempt a repair pass on failure.
	 */
	private parseAndRepairJSON<T>(
		text: string,
		providerName: string,
		model: string,
		promptId: string,
		requestId?: string,
	): T {
		try {
			return this.parseJSON<T>(text);
		} catch (parseError) {
			try {
				return JSON.parse(this.repairJSON(text)) as T;
			} catch (repairError) {
				throw new LLMParseError(
					`Failed to parse JSON response: ${repairError instanceof Error ? repairError.message : String(repairError)}`,
					providerName,
					model,
					text,
					promptId,
					requestId,
					parseError instanceof Error ? parseError : undefined,
				);
			}
		}
	}

	/**
	 * Validate a parsed value against a Zod schema.
	 * Returns the value unchanged when no schema is provided.
	 */
	private validateSchema<T>(
		parsed: T,
		schema: z.ZodSchema<T> | undefined,
		providerName: string,
		model: string,
		promptId: string,
		requestId?: string,
	): T {
		if (!schema) return parsed;

		try {
			return schema.parse(parsed);
		} catch (validationError) {
			if (validationError instanceof z.ZodError) {
				throw new LLMSchemaError(
					`Schema validation failed: ${validationError.message}`,
					providerName,
					model,
					validationError.errors.map(
						(e) => `${e.path.join(".")}: ${e.message}`,
					),
					promptId,
					requestId,
					validationError,
				);
			}
			throw validationError;
		}
	}

	// ─── Retry logic ─────────────────────────────────────────────────────────

	/**
	 * Call a provider fn with exponential backoff retries.
	 * Only retries on LLMTransientError; all other errors propagate immediately.
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

				if (!(error instanceof LLMTransientError)) throw error;
				if (attempt === maxRetries - 1) throw error;

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

		// Unreachable — every loop iteration either returns or throws
		throw lastError ?? new Error("Unknown error in retry loop");
	}

	// ─── JSON utilities ───────────────────────────────────────────────────────

	/**
	 * Parse JSON with a descriptive error message
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
	 * Repair JSON by stripping markdown fences and extracting the first brace pair
	 */
	private repairJSON(text: string): string {
		let repaired = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
		repaired = repaired.replace(/\s*```\s*$/i, "");

		const firstBrace = repaired.indexOf("{");
		const lastBrace = repaired.lastIndexOf("}");

		if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
			repaired = repaired.substring(firstBrace, lastBrace + 1);
		}

		return repaired.trim();
	}

	// ─── Utilities ────────────────────────────────────────────────────────────

	/**
	 * Build cache key from params.
	 * Uses nullish check for temperature so that 0 is not treated as "unset".
	 */
	private buildCacheKey(
		params: LLMTextParams | LLMJsonParams,
		prompt: { promptId: string; version: string | number },
	): string {
		const keyParts = [
			params.idempotencyKey ?? "",
			prompt.promptId,
			String(prompt.version),
			JSON.stringify(params.variables ?? {}),
			params.model ?? "",
			params.temperature != null ? String(params.temperature) : "",
		];

		return createHash("sha256").update(keyParts.join("|")).digest("hex");
	}

	/**
	 * Generate a unique trace ID using crypto.randomUUID
	 */
	private generateTraceId(): string {
		return `trace_${randomUUID()}`;
	}

	/**
	 * Emit a structured log entry via the injected logger (no-op if none configured)
	 */
	private logCall(log: LLMCallLogEntry): void {
		if (this.logger) {
			this.logger.llmCall(log);
		}
	}

	/**
	 * Sleep utility for retry delays
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
