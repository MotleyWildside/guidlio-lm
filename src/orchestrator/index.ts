/**
 * Pipeline Orchestrator Framework
 *
 * A minimal-but-production-ready FSM-capable framework for running step-based
 * pipelines with context passing, policy-driven transitions, retries, and observability.
 *
 * @see README.md for usage examples
 */

export { PipelineOrchestrator } from "./PipelineOrchestrator";

export type {
	StepResult,
	StepOutcome,
	StepOutcomeOk,
	StepOutcomeFailed,
	StepOutcomeRedirect,
	StepRunMeta,
	Transition,
	PipelinePolicy,
	PolicyDecisionInput,
	PolicyDecisionOutput,
	ContextAdjustment,
	PipelineRunResult,
	PipelineStatus,
	PipelineOrchestratorConfig,
	PipelineRunOptions,
	BaseContext,
	OkArgs,
	FailedArgs,
	RedirectArgs,
} from "./types";
export { PipelineStep } from "./types";

export { RetryPolicy, RedirectRoutingPolicy, DefaultPolicy } from "./policies";
export type { RetryPolicyOptions, RouteMap } from "./policies";

export {
	PipelineError,
	PipelineDefinitionError,
	StepExecutionError,
	PipelineAbortedError,
} from "./errors";

export { LoggerPipelineObserver, NoopPipelineObserver } from "./observers";
export type { PipelineObserver } from "./observers";

export {
	PIPELINE_STATUS,
	OUTCOME_TYPE,
	TRANSITION_TYPE,
	DEFAULT_MAX_TRANSITIONS,
} from "./constants";

export { ok, failed, redirect } from "./statusHelpers";
