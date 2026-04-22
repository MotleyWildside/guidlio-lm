import type { LLMLogger, LLMCallLogEntry } from "../../logger/types";

/**
 * Shared context carried through a single LLM call.
 * Every log line a call emits derives its common fields from this struct.
 */
export interface CallContext {
	traceId: string;
	promptId?: string;
	promptVersion?: string | number;
	model: string;
	providerName: string;
	startedAt: number;
}

/**
 * Emit an `llmCall` log entry using fields from the context.
 * Caller-supplied `outcome` takes precedence over context-derived defaults,
 * so `durationMs` can be overridden (e.g. for mid-flight retry logs).
 */
export function logOutcome(
	logger: LLMLogger | null,
	ctx: CallContext,
	outcome: Partial<LLMCallLogEntry> & { success: boolean },
): void {
	if (!logger) return;
	logger.llmCall({
		traceId: ctx.traceId,
		promptId: ctx.promptId,
		promptVersion: ctx.promptVersion,
		model: ctx.model,
		provider: ctx.providerName,
		durationMs: Date.now() - ctx.startedAt,
		...outcome,
	});
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
