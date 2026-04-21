/**
 * Base error class for all orchestrator-related errors.
 */
export class OrchestratorError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = 'OrchestratorError';
    Object.setPrototypeOf(this, OrchestratorError.prototype);
  }
}

/**
 * Base class for pipeline-specific errors.
 */
export class PipelineError extends OrchestratorError {
  constructor(
    message: string,
    public readonly traceId: string,
    public readonly stepName?: string,
    statusCode: number = 500,
    public readonly cause?: unknown
  ) {
    super(message, statusCode);
    this.name = 'PipelineError';
    Object.setPrototypeOf(this, PipelineError.prototype);
  }
}

/**
 * Error thrown when a pipeline definition is invalid.
 */
export class PipelineDefinitionError extends OrchestratorError {
  constructor(message: string) {
    super(message, 500);
    this.name = 'PipelineDefinitionError';
    Object.setPrototypeOf(this, PipelineDefinitionError.prototype);
  }
}

/**
 * Error thrown when a step execution fails.
 */
export class StepExecutionError extends PipelineError {
  constructor(
    message: string,
    traceId: string,
    stepName?: string,
    statusCode: number = 500,
    cause?: unknown
  ) {
    super(message, traceId, stepName, statusCode, cause);
    this.name = 'StepExecutionError';
    Object.setPrototypeOf(this, StepExecutionError.prototype);
  }
}
