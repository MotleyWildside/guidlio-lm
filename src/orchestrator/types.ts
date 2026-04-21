/**
 * Core types for the Pipeline Orchestrator framework.
 */

import { PipelineError } from './errors';
import type { PipelineObserver } from './observers';

/**
 * Base context for all pipelines.
 * Ensures traceId and errors array are always available.
 */
export interface BaseContext {
  /**
   * Raw input from the user request (typically from req.body)
   */
  input?: unknown;

  /**
   * The trace ID for the entire run
   */
  traceId: string;
}

/**
 * Clarification question that a step can request when it needs more information.
 */

/**
 * Semantic outcome of a step execution (domain/business logic, not control flow).
 * The outcome describes WHAT happened, not WHERE to go next.
 */
export type StepOutcome =
  | StepOutcomeOk
  | StepOutcomeFailed
  | StepOutcomeRedirect;

export type StepOutcomeOk = { type: 'ok' };
export type StepOutcomeFailed = {
  type: 'failed';
  error: Error;
  retryable?: boolean;
  statusCode?: number;
};
export type StepOutcomeRedirect = {
  type: 'redirect';
  message?: string;
};
export type StepResult<C extends BaseContext> = {
  ctx: C;
  outcome: StepOutcome;
};

/**
 * Transition decision made by the policy (control flow).
 * This determines WHERE the executor should go next.
 */
export type Transition =
  | { type: 'next' }
  | { type: 'goto'; stepName: string }
  | { type: 'retry'; stepName?: string }
  | { type: 'stop' }
  | { type: 'fail'; error: Error; statusCode?: number }
  | { type: 'degrade'; reason: string };

/**
 * Context adjustment that can be applied during a transition.
 */
export type ContextAdjustment<C extends BaseContext> =
  | { type: 'none' }
  | { type: 'patch'; patch: Partial<C> }
  | { type: 'override'; ctx: C };

/**
 * Input to the policy decision function.
 */
export type PolicyDecisionInput<C extends BaseContext> = {
  stepName: string;
  stepResult: StepResult<C>;
  traceId: string;
};

/**
 * Output from the policy decision function.
 */
export type PolicyDecisionOutput<C extends BaseContext> = {
  transition: Transition;
  contextAdjustment?: ContextAdjustment<C>;
};

/**
 * Policy interface for deciding transitions based on step outcomes.
 */
export interface PipelinePolicy<C extends BaseContext> {
  decide(input: PolicyDecisionInput<C>): PolicyDecisionOutput<C>;
  reset(): void;
}

/**
 * Class for pipeline steps.
 * Extend this class to create your own pipeline steps.
 */
export abstract class PipelineStep<C extends BaseContext> {
  /**
   * The unique name of this step.
   * Must be unique within a pipeline.
   */
  abstract readonly name: string;

  /**
   * Executes the step with the given context.
   * @param ctx The pipeline context
   * @returns A promise that resolves to a step result
   */
  abstract run(ctx: C): Promise<StepResult<C>>;
}
/**
 * Result returned by executeStep, which no longer includes step metadata.
 */
export type StepExecutionResult<C extends BaseContext> = {
  stepResult: StepResult<C>;
};

/**
 * Result returned by the pipeline orchestrator after execution.
 */
export type PipelineRunResult<C extends BaseContext> =
  | { status: 'ok'; ctx: C }
  | { status: 'failed'; ctx: C; error: PipelineError };

/**
 * Input to retry decision function.
 */
export type RetryDecisionInput = {
  stepName: string;
  error?: Error;
  outcome?: StepOutcome;
  attempt: number;
  traceId: string;
};

/**
 * Retry policy configuration for a step.
 */
export type RetryPolicy = {
  maxAttempts: number;
  shouldRetry: (input: RetryDecisionInput) => boolean;
  backoffMs: (attempt: number) => number;
};

/**
 * Configuration for creating a PipelineExecutor.
 */
export type PipelineOrchestratorConfig<C extends BaseContext> = {
  steps: PipelineStep<C>[];
  observer?: PipelineObserver;
  policy?: PipelinePolicy<C>;
};

/**
 * Options for running a pipeline.
 */
export type PipelineRunOptions = {
  traceId?: string;
};

export type OkArgs<C extends BaseContext> = {
  ctx: C;
};

export type FailedArgs<C extends BaseContext> = {
  ctx: C;
  error: Error;
  retryable?: boolean;
  statusCode?: number;
};

export type RedirectArgs<C extends BaseContext> = {
  ctx: C;
  message?: string;
};
