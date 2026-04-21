/**
 * Observability hooks for pipeline execution.
 */

import type { StepOutcome } from './types';
import { logger } from '../logger/logger';

/**
 * Observer interface for tracking pipeline execution events.
 * All methods are optional and default to no-op.
 */
export interface PipelineObserver {
  /**
   * Called when a pipeline run starts.
   */
  onRunStart(params: { traceId: string }): void;

  /**
   * Called when a step starts execution.
   */
  onStepStart(params: { traceId: string; stepName: string }): void;

  /**
   * Called when a step finishes execution.
   */
  onStepFinish(params: {
    traceId: string;
    stepName: string;
    outcome: StepOutcome;
    durationMs: number;
  }): void;

  /**
   * Called when a pipeline run finishes (successfully or with failure).
   */
  onRunFinish(params: {
    traceId: string;
    outcome: string;
    durationMs: number;
  }): void;

  /**
   * Called when an error occurs during step execution.
   */
  onError(params: { traceId: string; stepName?: string; error: Error }): void;
}

/**
 * Logger-based observer that logs structured JSON events.
 * Now delegates to logger.pipelineEvent which handles environment-specific formatting.
 */
export class LoggerPipelineObserver implements PipelineObserver {
  onRunStart(params: { traceId: string }): void {
    logger.pipelineEvent({
      event: 'Pipeline started',
      traceId: params.traceId,
    });
  }

  onStepStart(params: { traceId: string; stepName: string }): void {
    logger.pipelineEvent({
      event: 'Step started',
      traceId: params.traceId,
      stepName: params.stepName,
    });
  }

  onStepFinish(params: {
    traceId: string;
    stepName: string;
    outcome: StepOutcome;
    durationMs: number;
  }): void {
    logger.pipelineEvent({
      event: 'Step finished',
      traceId: params.traceId,
      stepName: params.stepName,
      outcome: params.outcome.type,
      durationMs: params.durationMs,
    });
  }

  onRunFinish(params: {
    traceId: string;
    outcome: string;
    durationMs: number;
  }): void {
    logger.pipelineEvent({
      event: 'Pipeline finished',
      traceId: params.traceId,
      outcome: params.outcome,
      durationMs: params.durationMs,
    });
  }

  onError(params: { traceId: string; stepName?: string; error: Error }): void {
    logger.pipelineEvent({
      event: 'Pipeline error',
      traceId: params.traceId,
      stepName: params.stepName,
      error: params.error,
    });
  }
}
