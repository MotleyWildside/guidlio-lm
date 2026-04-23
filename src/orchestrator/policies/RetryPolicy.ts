import { DefaultPolicy } from './DefaultPolicy';
import type {
	BaseContext,
	StepOutcomeFailed,
	PolicyDecisionInput,
	Transition,
} from '../types';

export type RetryPolicyOptions = {
	/**
	 * Maximum number of executions per step (first attempt + retries).
	 * Default: 3.
	 */
	maxAttempts?: number;
	/**
	 * Return true when the failed outcome should be retried.
	 * Default: `outcome.retryable === true`.
	 */
	retryIf?: (outcome: StepOutcomeFailed, input: PolicyDecisionInput<BaseContext>) => boolean;
	/**
	 * Delay in milliseconds before the retry attempt is executed.
	 * Receives the 1-based attempt number that just failed (so attempt=1 is the
	 * delay before the second execution).
	 * Default: exponential back-off — `Math.min(100 * 2 ** (attempt - 1), 30_000)`.
	 *   attempt 1 → 100 ms
	 *   attempt 2 → 200 ms
	 *   attempt 3 → 400 ms …
	 */
	backoffMs?: (attempt: number) => number;
};

const defaultBackoff = (attempt: number) => Math.min(100 * 2 ** (attempt - 1), 30_000);

/**
 * Drop-in policy that retries failed steps with configurable back-off.
 *
 * Usage:
 * ```ts
 * new PipelineOrchestrator({
 *   steps: [...],
 *   policy: () => new RetryPolicy({ maxAttempts: 5, backoffMs: attempt => attempt * 500 }),
 * });
 * ```
 *
 * Pass a factory `() => new RetryPolicy(...)` (not an instance) so each concurrent
 * `run()` gets isolated attempt counters.
 */
export class RetryPolicy<C extends BaseContext> extends DefaultPolicy<C> {
	private readonly maxAttempts: number;
	private readonly retryIf: (outcome: StepOutcomeFailed, input: PolicyDecisionInput<BaseContext>) => boolean;
	private readonly backoffMs: (attempt: number) => number;
	private readonly attemptCounts = new Map<string, number>();

	constructor(options: RetryPolicyOptions = {}) {
		super();
		this.maxAttempts = options.maxAttempts ?? 3;
		this.retryIf = options.retryIf ?? ((outcome) => outcome.retryable === true);
		this.backoffMs = options.backoffMs ?? defaultBackoff;
	}

	protected override fail(outcome: StepOutcomeFailed, input: PolicyDecisionInput<C>): Transition {
		if (!this.retryIf(outcome, input as PolicyDecisionInput<BaseContext>)) {
			return super.fail(outcome, input);
		}

		const attempts = this.attemptCounts.get(input.stepName) ?? 0;

		if (attempts + 1 < this.maxAttempts) {
			this.attemptCounts.set(input.stepName, attempts + 1);
			return {
				type: 'retry',
				delayMs: this.backoffMs(attempts + 1),
			};
		}

		return super.fail(outcome, input);
	}

	override reset(): void {
		this.attemptCounts.clear();
	}
}
