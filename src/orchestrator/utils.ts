/**
 * Utility functions for the Pipeline Executor framework.
 */

import type { PipelineRunOptions } from './types';

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
 */
export function getTraceId<C>(ctx: C, opts?: PipelineRunOptions): string {
  if (opts?.traceId) {
    return opts.traceId;
  }
  // Check if ctx has a traceId property
  if (typeof ctx === 'object' && ctx !== null && 'traceId' in ctx) {
    const traceId = (ctx as { traceId?: unknown }).traceId;
    if (typeof traceId === 'string' && traceId.length > 0) {
      return traceId;
    }
  }
  return generateTraceId();
}

/**
 * Parse YYYY-MM-DD date string to Date object
 */
export function parseDate(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00');
}
