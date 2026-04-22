/**
 * Pipeline Orchestrator Framework
 *
 * A minimal-but-production-ready FSM-capable framework for running step-based
 * pipelines with context passing, policy-driven transitions, retries, and observability.
 *
 * @see README.md for usage examples
 */

export { PipelineOrchestrator } from './PipelineOrchestrator';

export type {
  StepResult,
  StepOutcome,
  StepOutcomeOk,
  StepOutcomeFailed,
  StepOutcomeRedirect,
  Transition,
  PipelinePolicy,
  PolicyDecisionInput,
  PolicyDecisionOutput,
  ContextAdjustment,
  PipelineRunResult,
  PipelineStatus,
  RetryPolicy,
  RetryDecisionInput,
  PipelineOrchestratorConfig,
  PipelineRunOptions,
  BaseContext,
} from './types';
export { PipelineStep } from './types';
export { DefaultPolicy } from './DefaultPolicy';

export {
  PipelineError,
  PipelineDefinitionError,
  StepExecutionError,
} from './errors';

export { LoggerPipelineObserver } from './observers';
export type { PipelineObserver } from './observers';

export {
  PIPELINE_STATUS,
  OUTCOME_TYPE,
  TRANSITION_TYPE,
  DEFAULT_MAX_TRANSITIONS,
} from './constants';

export { ok, failed, redirect } from './statusHelpers';
export type { OkArgs, FailedArgs, RedirectArgs } from './types';
