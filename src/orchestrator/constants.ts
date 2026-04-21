/**
 * Constants for pipeline status values.
 */

/**
 * Step outcome types (semantic, not control flow).
 * @deprecated Use StepOutcome type instead. Kept for backward compatibility.
 */
export const STEP_STATUS = {
  CONTINUE: 'continue',
  STOP: 'stop',
  ERROR: 'error',
} as const;

/**
 * Step outcome types (semantic).
 */
export const OUTCOME_TYPE = {
  OK: 'ok',
  FAILED: 'failed',
  REDIRECT: 'redirect',
} as const;

/**
 * Transition types (control flow).
 */
export const TRANSITION_TYPE = {
  NEXT: 'next',
  GOTO: 'goto',
  RETRY: 'retry',
  STOP: 'stop',
  FAIL: 'fail',
  DEGRADE: 'degrade',
} as const;

/**
 * Pipeline run result statuses.
 */
export const PIPELINE_STATUS = {
  OK: 'ok',
  FAILED: 'failed',
} as const;

/**
 * Default maximum transitions to prevent infinite loops.
 */
export const DEFAULT_MAX_TRANSITIONS = 50;
