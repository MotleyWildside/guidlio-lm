export class OrchestratorError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number = 500,
	) {
		super(message);
		this.name = 'OrchestratorError';
		Object.setPrototypeOf(this, OrchestratorError.prototype);
	}
}

export class PipelineError extends OrchestratorError {
	constructor(
		message: string,
		public readonly traceId: string,
		public readonly stepName?: string,
		statusCode: number = 500,
		cause?: unknown,
	) {
		// ESNext / Node ≥18: forward cause to the native Error.cause field so
		// runtime tooling (Node, Sentry, etc.) can follow the chain automatically.
		super(message, statusCode);
		if (cause !== undefined) {
			Object.defineProperty(this, 'cause', { value: cause, configurable: true, writable: true });
		}
		this.name = 'PipelineError';
		Object.setPrototypeOf(this, PipelineError.prototype);
	}
}

/**
 * Thrown when a pipeline definition is invalid (programmer error).
 * Extends Error directly — this is a static configuration problem that should
 * propagate as an uncaught exception, not be swallowed into a PipelineRunResult.
 */
export class PipelineDefinitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PipelineDefinitionError';
		Object.setPrototypeOf(this, PipelineDefinitionError.prototype);
	}
}

export class StepExecutionError extends PipelineError {
	constructor(
		message: string,
		traceId: string,
		stepName?: string,
		statusCode: number = 500,
		cause?: unknown,
	) {
		super(message, traceId, stepName, statusCode, cause);
		this.name = 'StepExecutionError';
		Object.setPrototypeOf(this, StepExecutionError.prototype);
	}
}

/**
 * Thrown when a pipeline run is aborted via AbortSignal before the next step.
 * Uses HTTP 499 (client closed request) by convention.
 */
export class PipelineAbortedError extends PipelineError {
	constructor(traceId: string, stepName?: string, cause?: unknown) {
		super('Pipeline was aborted', traceId, stepName, 499, cause);
		this.name = 'PipelineAbortedError';
		Object.setPrototypeOf(this, PipelineAbortedError.prototype);
	}
}
