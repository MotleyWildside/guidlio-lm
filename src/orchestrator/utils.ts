/**
 * Utility functions for the Pipeline Executor framework.
 */

import type { BaseContext, PipelineRunOptions } from './types';

/**
 * Generates a trace ID using crypto.randomUUID() or a fallback.
 */
export function generateTraceId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Extracts or generates a trace ID from context or options.
 * C extends BaseContext guarantees ctx.traceId is always a string — no runtime
 * duck-typing needed.
 */
export function getTraceId<C extends BaseContext>(
  ctx: C,
  opts?: PipelineRunOptions
): string {
  if (opts?.traceId) return opts.traceId;
  if (ctx.traceId) return ctx.traceId;
  return generateTraceId();
}
