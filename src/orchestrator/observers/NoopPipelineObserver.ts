import type { StepOutcome, PipelineStatus, Transition } from '../types';
import type { PipelineObserver } from './PipelineObserver';

/**
 * No-op observer. Use as a base class or pass directly when observability is
 * handled externally (metrics layer, custom middleware, etc.).
 */
export class NoopPipelineObserver implements PipelineObserver {
	onRunStart(_params: { traceId: string }): void {}
	onStepStart(_params: { traceId: string; stepName: string }): void {}
	onStepFinish(_params: {
		traceId: string;
		stepName: string;
		outcome: StepOutcome;
		durationMs: number;
	}): void {}
	onRunFinish(_params: { traceId: string; outcome: PipelineStatus; durationMs: number }): void {}
	onError(_params: { traceId: string; stepName?: string; error: Error }): void {}
	onTransition?(_params: { traceId: string; stepName: string; transition: Transition }): void {}
}
