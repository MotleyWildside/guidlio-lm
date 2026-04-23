import type { StepOutcome, PipelineStatus, Transition } from '../types';

/**
 * Observer interface for tracking pipeline execution events.
 * All lifecycle methods are required; `onTransition` is optional so existing
 * observer implementations do not need to be updated.
 */
export interface PipelineObserver {
	onRunStart(params: { traceId: string }): void;
	onStepStart(params: { traceId: string; stepName: string }): void;
	onStepFinish(params: {
		traceId: string;
		stepName: string;
		outcome: StepOutcome;
		durationMs: number;
	}): void;
	onRunFinish(params: { traceId: string; outcome: PipelineStatus; durationMs: number }): void;
	onError(params: { traceId: string; stepName?: string; error: Error }): void;
	/**
	 * Called after the policy decides a transition and before it is applied.
	 * Optional — omitting it is equivalent to a no-op implementation.
	 */
	onTransition?(params: { traceId: string; stepName: string; transition: Transition }): void;
}
