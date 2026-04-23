import type {
	PipelinePolicy,
	PolicyDecisionInput,
	PolicyDecisionOutput,
	StepOutcomeFailed,
	StepOutcomeOk,
	StepOutcomeRedirect,
	Transition,
	BaseContext,
} from '../types';
import { OUTCOME_TYPE, TRANSITION_TYPE } from '../constants';

/**
 * Base class for pipeline policies. Subclass and override protected methods to
 * customise behaviour (e.g. retry logic, redirect handling).
 *
 * Default behaviour:
 * - outcome "ok"       → NEXT
 * - outcome "failed"   → FAIL (original error passed through, no re-wrapping)
 * - outcome "redirect" → FAIL (redirect requires a routing policy — override redirect() or decide())
 *
 * Every protected method receives the full `PolicyDecisionInput` as its second
 * argument so subclass overrides have access to stepName, traceId, and the
 * complete StepResult without needing to store them separately.
 */
export class DefaultPolicy<C extends BaseContext> implements PipelinePolicy<C> {
	decide(input: PolicyDecisionInput<C>): PolicyDecisionOutput<C> | Promise<PolicyDecisionOutput<C>> {
		return { transition: this.getTransitionForOutcome(input) };
	}

	private getTransitionForOutcome(input: PolicyDecisionInput<C>): Transition {
		const { outcome } = input.stepResult;
		switch (outcome.type) {
			case OUTCOME_TYPE.OK:
				return this.ok(outcome, input);

			case OUTCOME_TYPE.FAILED:
				return this.fail(outcome, input);

			case OUTCOME_TYPE.REDIRECT:
				return this.redirect(outcome, input);

			default: {
				const _exhaustive: never = outcome;
				return {
					type: TRANSITION_TYPE.FAIL,
					error: new Error(`Unknown outcome type: ${JSON.stringify(_exhaustive)}`),
				};
			}
		}
	}

	protected ok(_outcome: StepOutcomeOk, _input: PolicyDecisionInput<C>): Transition {
		return { type: TRANSITION_TYPE.NEXT };
	}

	/**
	 * `redirect` is a routing signal — it has no meaningful default because the
	 * policy doesn't know where to send the pipeline. Override `redirect()` or
	 * `decide()` in a subclass to map redirect outcomes to GOTO transitions.
	 */
	protected redirect(_outcome: StepOutcomeRedirect, input: PolicyDecisionInput<C>): Transition {
		return {
			type: TRANSITION_TYPE.FAIL,
			error: new Error(
				`Step "${input.stepName}" emitted a redirect but no routing is configured. ` +
				`Override DefaultPolicy.redirect() or decide() to handle it.`,
			),
		};
	}

	/**
	 * Passes the original error through without re-wrapping, preserving its
	 * class and stack trace. Override to add retry logic.
	 */
	protected fail(outcome: StepOutcomeFailed, _input: PolicyDecisionInput<C>): Transition {
		return {
			type: TRANSITION_TYPE.FAIL,
			error: outcome.error,
			statusCode: outcome.statusCode,
		};
	}

	reset(): void {}
}
