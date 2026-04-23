import { PipelineError } from './errors';
import type { PipelineObserver } from './observers';
import { PIPELINE_STATUS } from './constants';

export interface BaseContext {
	input?: unknown;
	traceId: string;
}

/**
 * Per-invocation metadata supplied by the orchestrator to each step.
 * Use `attempt` to implement step-internal backoff; `signal` to honour cancellation.
 */
export type StepRunMeta = {
	attempt: number;
	previousOutcome?: StepOutcome;
	signal?: AbortSignal;
};

/**
 * Semantic outcome of a step execution (domain/business logic, not control flow).
 * Describes WHAT happened, not WHERE to go next.
 */
export type StepOutcome = StepOutcomeOk | StepOutcomeFailed | StepOutcomeRedirect;

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
 * Determines WHERE the executor should go next.
 */
export type Transition =
	| { type: 'next' }
	| { type: 'goto'; stepName: string }
	| { type: 'retry'; stepName?: string; delayMs?: number }
	| { type: 'stop' }
	| { type: 'fail'; error: Error; statusCode?: number }
	| { type: 'degrade'; reason: string };

/**
 * Context adjustment that can be applied during a transition.
 * `override` replaces the entire context — the orchestrator preserves `traceId`
 * if the replacement object omits it.
 */
export type ContextAdjustment<C extends BaseContext> =
	| { type: 'none' }
	| { type: 'patch'; patch: Partial<C> }
	| { type: 'override'; ctx: C };

export type PolicyDecisionInput<C extends BaseContext> = {
	stepName: string;
	stepResult: StepResult<C>;
	traceId: string;
};

export type PolicyDecisionOutput<C extends BaseContext> = {
	transition: Transition;
	contextAdjustment?: ContextAdjustment<C>;
};

/**
 * Policy interface for deciding transitions based on step outcomes.
 * `decide` may return synchronously or return a Promise — both are supported
 * by the orchestrator, enabling async policy lookups (feature flags, DB, etc.).
 */
export interface PipelinePolicy<C extends BaseContext> {
	decide(
		input: PolicyDecisionInput<C>,
	): PolicyDecisionOutput<C> | Promise<PolicyDecisionOutput<C>>;
	reset(): void;
}

/**
 * Extend this class to create pipeline steps.
 * `meta` carries the attempt count, previous outcome (on retries), and the
 * run's AbortSignal — use it for retry-aware logic and cooperative cancellation.
 */
export abstract class PipelineStep<C extends BaseContext> {
	abstract readonly name: string;
	abstract run(ctx: C, meta: StepRunMeta): Promise<StepResult<C>>;
}

export type PipelineStatus = (typeof PIPELINE_STATUS)[keyof typeof PIPELINE_STATUS];

/**
 * Result returned by the pipeline orchestrator after execution.
 * `degraded` is present when the pipeline completed via a DEGRADE transition;
 * its `reason` string is the value supplied by the policy.
 */
export type PipelineRunResult<C extends BaseContext> =
	| { status: 'ok'; ctx: C; degraded?: { reason: string } }
	| { status: 'failed'; ctx: C; error: PipelineError };

export type PipelineOrchestratorConfig<C extends BaseContext> = {
	steps: PipelineStep<C>[];
	observer?: PipelineObserver;
	/**
	 * Provide a policy instance for sequential pipelines, or a factory function
	 * `() => PipelinePolicy` for concurrent-safe usage (the factory is called
	 * once per `run()` invocation, giving each run isolated policy state).
	 */
	policy?: PipelinePolicy<C> | (() => PipelinePolicy<C>);
	/**
	 * Maximum number of loop iterations (step executions + transitions) per run.
	 * Guards against infinite goto/retry cycles. Defaults to DEFAULT_MAX_TRANSITIONS (50).
	 */
	maxTransitions?: number;
	/**
	 * Per-step wall-clock timeout in milliseconds. When exceeded the step is
	 * treated as a non-retryable failure. The step's Promise is not cancelled —
	 * pass `meta.signal` into the step's async work for cooperative cancellation.
	 */
	stepTimeoutMs?: number;
};

export type PipelineRunOptions = {
	traceId?: string;
	/**
	 * Aborting this signal causes the pipeline to stop before the next step
	 * with a `PipelineAbortedError`. The signal is forwarded to each step via
	 * `meta.signal` for cooperative cancellation of in-flight work.
	 */
	signal?: AbortSignal;
};

export type OkArgs<C extends BaseContext> = { ctx: C };
export type FailedArgs<C extends BaseContext> = {
	ctx: C;
	error: Error;
	retryable?: boolean;
	statusCode?: number;
};
export type RedirectArgs<C extends BaseContext> = { ctx: C; message?: string };
