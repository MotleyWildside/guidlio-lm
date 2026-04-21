import type {
  PipelineRunResult,
  PipelineStep,
  StepExecutionResult,
  PipelinePolicy,
  Transition,
  PolicyDecisionInput,
  StepOutcome,
  ContextAdjustment,
  StepResult,
  PipelineOrchestratorConfig,
  PipelineRunOptions,
  BaseContext,
} from './types';
import { PipelineDefinitionError, StepExecutionError } from './errors';
import { LoggerPipelineObserver, type PipelineObserver } from './observers';
import { getTraceId } from './utils';
import { PIPELINE_STATUS, TRANSITION_TYPE } from './constants';
import { DefaultPolicy } from './DefaultPolicy';

/**
 * Pipeline Executor with FSM-capable control flow.
 * Handles step execution, retries, policy-driven transitions, and observability.
 */
export class PipelineOrchestrator<C extends BaseContext> {
  private readonly stepsByName: Map<string, PipelineStep<C>>;
  private readonly stepOrder: string[];
  private readonly observer: PipelineObserver;
  private readonly policy: PipelinePolicy<C>;

  constructor(config: PipelineOrchestratorConfig<C>) {
    const stepNames = new Set<string>();
    const stepsByName = new Map<string, PipelineStep<C>>();
    const stepOrder: string[] = [];

    for (const step of config.steps) {
      if (stepNames.has(step.name)) {
        throw new PipelineDefinitionError(
          `Duplicate step name: "${step.name}". Step names must be unique.`
        );
      }
      stepNames.add(step.name);
      stepsByName.set(step.name, step);
      stepOrder.push(step.name);
    }

    this.stepsByName = stepsByName;
    this.stepOrder = stepOrder;
    this.observer = config.observer ?? new LoggerPipelineObserver();
    this.policy = config.policy ?? new DefaultPolicy<C>();
  }

  /**
   * Runs the pipeline with the given initial context using FSM control flow.
   */
  async run(
    initialCtx: C,
    opts?: PipelineRunOptions
  ): Promise<PipelineRunResult<C>> {
    const traceId = getTraceId(initialCtx, opts);
    const startTime = Date.now();
    let ctx = {
      ...initialCtx,
      traceId: initialCtx.traceId || traceId,
    } as C;

    this.observer.onRunStart({ traceId });

    this.policy.reset();

    try {
      let currentStepName = this.stepOrder[0];
      let finalRunResult: PipelineRunResult<C> | undefined;

      while (!finalRunResult) {
        const step = this.stepsByName.get(currentStepName);

        if (!step) {
          throw new PipelineDefinitionError(
            `Step "${currentStepName}" not found in pipeline definition.`
          );
        }

        const executionResult = await this.executeStep({
          step,
          ctx,
          traceId,
        });

        ctx = executionResult.stepResult.ctx;

        const policyInput: PolicyDecisionInput<C> = {
          stepName: currentStepName,
          stepResult: executionResult.stepResult,
          traceId,
        };

        const policyOutput = this.policy.decide(policyInput);
        const transition = policyOutput.transition;

        if (policyOutput.contextAdjustment) {
          ctx = this.applyContextAdjustment({
            ctx,
            adjustment: policyOutput.contextAdjustment,
          });
        }

        const result = await this.applyTransition({
          transition,
          ctx,
          currentStepName,
          traceId,
          startTime,
        });

        if (result.type === 'finish') {
          finalRunResult = result.result;
        } else {
          currentStepName = result.nextStepName;
        }
      }
      return finalRunResult;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const pipelineError = new StepExecutionError(
        `Unexpected error during pipeline execution: ${error instanceof Error ? error.message : String(error)}`,
        traceId,
        undefined,
        1,
        error
      );
      this.observer.onError({
        traceId,
        error: pipelineError,
      });
      this.observer.onRunFinish({
        traceId,
        outcome: PIPELINE_STATUS.FAILED,
        durationMs,
      });
      return {
        status: PIPELINE_STATUS.FAILED,
        ctx,
        error: pipelineError,
      };
    }
  }

  /**
   * Applies a context adjustment to the context.
   */
  private applyContextAdjustment(params: {
    ctx: C;
    adjustment: ContextAdjustment<C>;
  }): C {
    const { ctx, adjustment } = params;
    switch (adjustment.type) {
      case 'none':
        return ctx;
      case 'patch':
        return { ...ctx, ...adjustment.patch };
      case 'override':
        return adjustment.ctx;
      default:
        return ctx;
    }
  }

  /**
   * Applies a transition and returns either a finish result or the next step name.
   */
  private async applyTransition(params: {
    transition: Transition;
    ctx: C;
    currentStepName: string;
    traceId: string;
    startTime: number;
  }): Promise<
    | { type: 'finish'; result: PipelineRunResult<C> }
    | { type: 'continue'; nextStepName: string }
  > {
    const { transition, ctx, currentStepName, traceId, startTime } = params;
    const durationMs = Date.now() - startTime;

    switch (transition.type) {
      case TRANSITION_TYPE.NEXT: {
        const currentIndex = this.stepOrder.indexOf(currentStepName);
        if (currentIndex === -1 || currentIndex >= this.stepOrder.length - 1) {
          this.observer.onRunFinish({
            traceId,
            outcome: PIPELINE_STATUS.OK,
            durationMs,
          });
          return {
            type: 'finish',
            result: { status: PIPELINE_STATUS.OK, ctx },
          };
        }
        return {
          type: 'continue',
          nextStepName: this.stepOrder[currentIndex + 1],
        };
      }

      case TRANSITION_TYPE.GOTO: {
        if (!this.stepsByName.has(transition.stepName)) {
          throw new PipelineDefinitionError(
            `GOTO transition to unknown step: "${transition.stepName}"`
          );
        }
        return { type: 'continue', nextStepName: transition.stepName };
      }

      case TRANSITION_TYPE.RETRY: {
        const targetStep = transition.stepName ?? currentStepName;
        if (!this.stepsByName.has(targetStep)) {
          throw new PipelineDefinitionError(
            `RETRY transition to unknown step: "${targetStep}"`
          );
        }
        return { type: 'continue', nextStepName: targetStep };
      }

      case TRANSITION_TYPE.STOP: {
        this.observer.onRunFinish({
          traceId,
          outcome: PIPELINE_STATUS.OK,
          durationMs,
        });
        return {
          type: 'finish',
          result: { status: PIPELINE_STATUS.OK, ctx },
        };
      }

      case TRANSITION_TYPE.FAIL: {
        const error = new StepExecutionError(
          transition.error.message,
          traceId,
          currentStepName,
          transition.statusCode,
          transition.error
        );
        this.observer.onError({ traceId, stepName: currentStepName, error });
        this.observer.onRunFinish({
          traceId,
          outcome: PIPELINE_STATUS.FAILED,
          durationMs,
        });
        return {
          type: 'finish',
          result: {
            status: PIPELINE_STATUS.FAILED,
            ctx,
            error,
          },
        };
      }

      case TRANSITION_TYPE.DEGRADE: {
        this.observer.onRunFinish({
          traceId,
          outcome: PIPELINE_STATUS.OK,
          durationMs,
        });
        return {
          type: 'finish',
          result: { status: PIPELINE_STATUS.OK, ctx },
        };
      }

      default:
        throw new Error(
          `Unknown transition type: ${JSON.stringify(transition)}`
        );
    }
  }

  /**
   * Executes a step once. Retries are handled by the policy via GOTO/RETRY transitions.
   */
  private async executeStep(params: {
    step: PipelineStep<C>;
    ctx: C;
    traceId: string;
  }): Promise<StepExecutionResult<C>> {
    const { step, ctx, traceId } = params;
    const stepStartTime = Date.now();

    this.observer.onStepStart({
      traceId,
      stepName: step.name,
    });

    try {
      const stepResult = await step.run(ctx);
      const stepDurationMs = Date.now() - stepStartTime;

      this.observer.onStepFinish({
        traceId,
        stepName: step.name,
        outcome: stepResult.outcome,
        durationMs: stepDurationMs,
      });

      return { stepResult };
    } catch (error) {
      const stepDurationMs = Date.now() - stepStartTime;
      const caughtError =
        error instanceof Error ? error : new Error(String(error));

      const exceptionOutcome: StepOutcome = {
        type: 'failed',
        error: caughtError,
        retryable: true,
      };

      this.observer.onError({
        traceId,
        stepName: step.name,
        error: caughtError,
      });

      this.observer.onStepFinish({
        traceId,
        stepName: step.name,
        outcome: exceptionOutcome,
        durationMs: stepDurationMs,
      });

      const failedStepResult: StepResult<C> = {
        ctx,
        outcome: exceptionOutcome,
      };

      return { stepResult: failedStepResult };
    }
  }
}
