import {
  StepResult,
  OkArgs,
  FailedArgs,
  RedirectArgs,
  BaseContext,
} from './types';

/**
 * Helper to create a simple "ok" result.
 */
export function ok<C extends BaseContext>(args: OkArgs<C>): StepResult<C> {
  const { ctx } = args;
  return {
    ctx,
    outcome: { type: 'ok' },
  };
}

/**
 * Helper to create a "failed" result.
 */
export function failed<C extends BaseContext>(
  args: FailedArgs<C>
): StepResult<C> {
  const { ctx, error, retryable = true, statusCode } = args;
  return {
    ctx,
    outcome: { type: 'failed', error, retryable, statusCode },
  };
}

/**
 * Helper to create a "redirect" result.
 */
export function redirect<C extends BaseContext>(
  args: RedirectArgs<C>
): StepResult<C> {
  const { ctx, message } = args;
  return {
    ctx,
    outcome: { type: 'redirect', message },
  };
}
