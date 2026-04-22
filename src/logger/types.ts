/**
 * Structured log entry passed to the logger on every LLM call
 */
export interface LLMCallLogEntry {
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
}

/**
 * Interface for LLM Service logging
 */
export interface LLMLogger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, error?: unknown): void;
	debug(message: string, ...args: unknown[]): void;
	llmCall(log: LLMCallLogEntry): void;
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
