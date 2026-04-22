/**
 * Base error class for all LLM-related errors
 */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly model: string,
    public readonly promptId?: string,
    public readonly requestId?: string,
    public readonly statusCode?: number,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'LLMError';
    Object.setPrototypeOf(this, LLMError.prototype);
  }
}

/**
 * Transient errors that should be retried (timeouts, rate limits, 5xx)
 */
export class LLMTransientError extends LLMError {
  constructor(
    message: string,
    provider: string,
    model: string,
    promptId?: string,
    requestId?: string,
    statusCode?: number,
    cause?: Error
  ) {
    super(message, provider, model, promptId, requestId, statusCode, cause);
    this.name = 'LLMTransientError';
    Object.setPrototypeOf(this, LLMTransientError.prototype);
  }
}

/**
 * Permanent errors that should not be retried (401, 403, invalid request)
 */
export class LLMPermanentError extends LLMError {
  constructor(
    message: string,
    provider: string,
    model: string,
    promptId?: string,
    requestId?: string,
    statusCode?: number,
    cause?: Error
  ) {
    super(message, provider, model, promptId, requestId, statusCode, cause);
    this.name = 'LLMPermanentError';
    Object.setPrototypeOf(this, LLMPermanentError.prototype);
  }
}

/**
 * JSON parsing errors
 */
export class LLMParseError extends LLMError {
  constructor(
    message: string,
    provider: string,
    model: string,
    public readonly rawOutput: string,
    promptId?: string,
    requestId?: string,
    cause?: Error
  ) {
    super(message, provider, model, promptId, requestId, undefined, cause);
    this.name = 'LLMParseError';
    Object.setPrototypeOf(this, LLMParseError.prototype);
  }
}

/**
 * Schema validation errors
 */
export class LLMSchemaError extends LLMError {
  constructor(
    message: string,
    provider: string,
    model: string,
    public readonly validationErrors: string[],
    promptId?: string,
    requestId?: string,
    cause?: Error
  ) {
    super(message, provider, model, promptId, requestId, undefined, cause);
    this.name = 'LLMSchemaError';
    Object.setPrototypeOf(this, LLMSchemaError.prototype);
  }
}

