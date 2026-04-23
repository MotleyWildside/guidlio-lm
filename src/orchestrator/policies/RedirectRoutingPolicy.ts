import { DefaultPolicy } from './DefaultPolicy';
import type { BaseContext, StepOutcomeRedirect, PolicyDecisionInput, Transition } from '../types';

/**
 * A map from `outcome.message` to a step name.
 * ```ts
 * { 'use_tool': 'act', 'answer': 'finalize' }
 * ```
 */
export type RouteMap = Record<string, string>;

/**
 * Policy that maps `redirect` outcome messages to `GOTO` transitions using a
 * static route table. All other outcomes fall through to `DefaultPolicy` defaults.
 *
 * ```ts
 * new PipelineOrchestrator({
 *   steps: [...],
 *   policy: () => new RedirectRoutingPolicy({
 *     'use_tool': 'act',
 *     'answer':   'finalize',
 *   }),
 * });
 * ```
 *
 * Unknown messages produce a descriptive FAIL listing all known keys.
 * For async or context-aware routing, extend `DefaultPolicy` directly and
 * override `decide()` — the `agent-react-loop` example shows the pattern.
 */
export class RedirectRoutingPolicy<C extends BaseContext> extends DefaultPolicy<C> {
	constructor(private readonly routes: RouteMap) {
		super();
	}

	protected override redirect(
		outcome: StepOutcomeRedirect,
		input: PolicyDecisionInput<C>,
	): Transition {
		const target = outcome.message ? this.routes[outcome.message] : undefined;

		if (target) {
			return { type: 'goto', stepName: target };
		}

		const known = Object.keys(this.routes).join(', ');
		return {
			type: 'fail',
			error: new Error(
				`RedirectRoutingPolicy: no route for message "${outcome.message ?? '(none)'}" ` +
				`from step "${input.stepName}". Known messages: [${known}].`,
			),
		};
	}
}
