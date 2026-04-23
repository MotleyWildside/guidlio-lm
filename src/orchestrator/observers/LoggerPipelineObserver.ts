import type { StepOutcome, PipelineStatus, Transition } from '../types';
import type { PipelineObserver } from './PipelineObserver';
import { logger } from '../../logger/logger';

/**
 * Structured-logging observer backed by the package logger.
 * Pass an instance explicitly: `new PipelineOrchestrator({ observer: new LoggerPipelineObserver() })`.
 */
export class LoggerPipelineObserver implements PipelineObserver {
	onRunStart(params: { traceId: string }): void {
		logger.pipelineEvent({ event: 'Pipeline started', traceId: params.traceId });
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

	onRunFinish(params: { traceId: string; outcome: PipelineStatus; durationMs: number }): void {
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

	onTransition(params: { traceId: string; stepName: string; transition: Transition }): void {
		logger.pipelineEvent({
			event: `Transition → ${params.transition.type}`,
			traceId: params.traceId,
			stepName: params.stepName,
		});
	}
}
