import { LLMTransientError } from "../errors";
import type { LLMLogger } from "../../logger/types";
import type { LLMServiceConfig } from "../types";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
export const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Context fields needed to log a retry attempt.
 * (A subset of `CallContext` — retries don't care about timing.)
 */
export interface RetryLogContext {
	traceId?: string;
	promptId?: string;
	model: string;
	providerName: string;
}

/**
 * Call a provider fn with exponential backoff retries.
 * Only retries on `LLMTransientError`; all other errors propagate immediately.
 * `maxAttempts` is the total number of attempts (1 = no retries).
 */
export async function callWithRetries<T>(
	fn: () => Promise<T>,
	config: LLMServiceConfig,
	logger: LLMLogger | null,
	ctx: RetryLogContext,
): Promise<T> {
	const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const baseDelay = config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
	const maxDelay = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError =
				error instanceof Error ? error : new Error(String(error));

			if (!(error instanceof LLMTransientError)) throw error;
			if (attempt === maxAttempts - 1) throw error;

			const exp = baseDelay * Math.pow(2, attempt);
			const jitter = Math.random() * 1000;
			const delay = Math.min(exp + jitter, maxDelay);
			await sleep(delay);

			logger?.llmCall({
				traceId: ctx.traceId,
				promptId: ctx.promptId,
				model: ctx.model,
				provider: ctx.providerName,
				success: false,
				error: `Retry attempt ${attempt + 1}/${maxAttempts - 1}: ${lastError.message}`,
				retry: true,
				durationMs: 0,
			});
		}
	}

	// Unreachable — every loop iteration either returns or throws
	throw lastError ?? new Error("Unknown error in retry loop");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
