import type { BaseContext, PipelineRunOptions } from './types';

// Node ≥18 always has crypto.randomUUID — no fallback needed.
export function generateTraceId(): string {
	return crypto.randomUUID();
}

export function getTraceId<C extends BaseContext>(ctx: C, opts?: PipelineRunOptions): string {
	if (opts?.traceId) return opts.traceId;
	if (ctx.traceId) return ctx.traceId;
	return generateTraceId();
}
