/**
 * Base policy class for pipeline execution.
 * Provides conservative control flow decisions based on step outcomes.
 * Extend this class to implement custom policies (e.g. redirect handling).
 */

import type {
  PipelinePolicy,
  PolicyDecisionInput,
  PolicyDecisionOutput,
  StepOutcomeFailed,
  StepOutcomeOk,
  Transition,
  BaseContext,
} from './types';
import { OUTCOME_TYPE, TRANSITION_TYPE } from './constants';

/**
 * Base class for pipeline policies.
 * Subclass and override (e.g. decideRedirectTransition) to customize behavior.
 *
 * Default behavior:
 * - outcome "ok" -> NEXT
 * - outcome "failed" -> FAIL
 * - outcome "redirect" -> FAIL (override decideRedirectTransition for GOTO/DEGRADE)
 */
export class DefaultPolicy<C extends BaseContext> implements PipelinePolicy<C> {
  decide(input: PolicyDecisionInput<C>): PolicyDecisionOutput<C> {
    const transition = this.getTransitionForOutcome(input);

    return { transition };
  }

  /**
   * Decides the transition based on the outcome type.
   */
  private getTransitionForOutcome(input: PolicyDecisionInput<C>): Transition {
    const { outcome } = input.stepResult;
    switch (outcome.type) {
      case OUTCOME_TYPE.OK:
        return this.ok(outcome);

      case OUTCOME_TYPE.FAILED:
        return this.fail(outcome);

      case OUTCOME_TYPE.REDIRECT:
        return this.redirect(input);

      default:
        return {
          type: TRANSITION_TYPE.FAIL,
          error: new Error(`Unknown outcome type: ${JSON.stringify(outcome)}`),
        };
    }
  }

  protected ok(_: StepOutcomeOk): Transition {
    return {
      type: TRANSITION_TYPE.NEXT,
    };
  }

  protected redirect(input: PolicyDecisionInput<C>): Transition {
    return {
      type: TRANSITION_TYPE.FAIL,
      error: new Error(`Redirect in step: ${input.stepName}`),
    };
  }

  protected fail(outcome: StepOutcomeFailed): Transition {
    return {
      type: TRANSITION_TYPE.FAIL,
      error: new Error(outcome.error.message),
      statusCode: outcome.statusCode,
    };
  }

  /**
   * Resets the redirect attempt counters.
   * Called at the start of each pipeline run.
   */
  reset(): void {}
}
