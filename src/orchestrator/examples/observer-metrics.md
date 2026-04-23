# Observer Metrics

A `PipelineObserver` receives lifecycle hooks for every step start, step finish, transition, run finish, and error. This makes it the right place to emit Prometheus-style metrics — latency histograms, outcome counters, and error rates — without touching step or policy logic.

**Concepts covered:**
- `MetricsObserver` implementing `PipelineObserver`
- `onStepStart`: capturing a start timestamp per step
- `onStepFinish`: emitting duration and outcome counters
- `onRunFinish`: emitting run-level duration and outcome
- `onError`: incrementing an error counter
- One `MetricsObserver` per orchestrator instance (stateful — holds timers)

---

## The PipelineObserver interface

```typescript
import {
	PipelineObserver,
	NoopPipelineObserver,
	StepOutcome,
	PipelineRunResult,
} from "guidlio-lm";
```

`NoopPipelineObserver` provides empty implementations of every hook so you only override the ones you need.

---

## MetricsObserver

The example below uses a `prom-client`-style placeholder API. Replace the `counter.labels({...}).inc()` and `histogram.labels({...}).observe(value)` calls with your actual metrics library.

```typescript
// Placeholder types — replace with your actual prom-client or metrics SDK imports
interface Counter {
	labels(labels: Record<string, string>): { inc(): void };
}
interface Histogram {
	labels(labels: Record<string, string>): { observe(value: number): void };
}

// In a real app these are module-level singletons registered with a Prometheus registry
declare const pipelineStepDurationMs: Histogram;   // pipeline_step_duration_ms
declare const pipelineStepTotal: Counter;           // pipeline_step_total
declare const pipelineRunTotal: Counter;             // pipeline_run_total
declare const pipelineRunDurationMs: Histogram;     // pipeline_run_duration_ms
declare const pipelineErrorsTotal: Counter;          // pipeline_errors_total

import { NoopPipelineObserver, PipelineObserver, BaseContext, PipelineRunResult } from "guidlio-lm";

class MetricsObserver<C extends BaseContext>
	extends NoopPipelineObserver
	implements PipelineObserver
{
	// Each run gets its own entry — concurrent runs are isolated by traceId
	private readonly stepStartTimes = new Map<string, number>();
	private runStartTime = 0;

	override onRunStart(params: { traceId: string }): void {
		this.runStartTime = Date.now();
	}

	override onStepStart(params: { traceId: string; stepName: string }): void {
		// Key on stepName — steps run sequentially within a single run, so
		// a Map<stepName, startTime> is sufficient for one orchestrator instance
		this.stepStartTimes.set(params.stepName, Date.now());
	}

	override onStepFinish(params: {
		traceId: string;
		stepName: string;
		outcome: { type: string };
	}): void {
		const startTime = this.stepStartTimes.get(params.stepName);
		if (startTime !== undefined) {
			const durationMs = Date.now() - startTime;
			this.stepStartTimes.delete(params.stepName);

			// Histogram: one observation per step execution
			pipelineStepDurationMs
				.labels({ stepName: params.stepName })
				.observe(durationMs);
		}

		// Counter: track outcomes (ok / failed / redirect) per step
		pipelineStepTotal
			.labels({ stepName: params.stepName, outcome: params.outcome.type })
			.inc();
	}

	override onRunFinish(params: {
		traceId: string;
		result: PipelineRunResult<C>;
	}): void {
		const durationMs = Date.now() - this.runStartTime;

		pipelineRunDurationMs
			.labels({ status: params.result.status })
			.observe(durationMs);

		pipelineRunTotal
			.labels({
				status: params.result.status,
				// Distinguish degraded ok from clean ok
				degraded: params.result.status === "ok" && params.result.degraded ? "true" : "false",
			})
			.inc();
	}

	override onError(params: { traceId: string; stepName?: string; error: Error }): void {
		// onError fires for unexpected thrown exceptions (not for failed() outcomes).
		// Increment a separate counter so you can alert on unhandled errors.
		pipelineErrorsTotal
			.labels({ stepName: params.stepName ?? "unknown" })
			.inc();
	}
}
```

---

## Wiring the observer

```typescript
import { GuidlioOrchestrator, RetryPolicy } from "guidlio-lm";
import { BaseContext } from "guidlio-lm";

interface WorkerContext extends BaseContext {
	jobId: string;
	result?: string;
}

// One MetricsObserver per orchestrator instance.
// Do NOT share one observer across multiple orchestrator instances — the
// stepStartTimes Map would mix entries from different pipelines.
const metricsObserver = new MetricsObserver<WorkerContext>();

const orchestrator = new GuidlioOrchestrator<WorkerContext>({
	steps: [
		/* ...your steps... */
	],
	policy: () => new RetryPolicy({ maxAttempts: 3 }),
	observer: metricsObserver,
});

// Multiple sequential runs share the same observer safely because
// onRunStart resets runStartTime and steps run one at a time within a run.
const result1 = await orchestrator.run({ traceId: "job-1", jobId: "abc" });
const result2 = await orchestrator.run({ traceId: "job-2", jobId: "def" });
```

> **Note on concurrency:** `MetricsObserver` holds mutable state (the `stepStartTimes` Map and `runStartTime`). It is safe for one orchestrator running sequential runs. For concurrent runs on the same orchestrator, the `stepStartTimes` keys would collide if two runs execute a step with the same name simultaneously. In that case, key the Map on `traceId + stepName` instead of `stepName` alone, and clean up entries in `onRunFinish`.

---

## Scraping the metrics

The metrics defined above expose the following Prometheus metric families:

| Metric | Type | Labels | Description |
| :--- | :--- | :--- | :--- |
| `pipeline_step_duration_ms` | Histogram | `stepName` | Wall-clock time per step execution |
| `pipeline_step_total` | Counter | `stepName`, `outcome` | Count of step executions by outcome |
| `pipeline_run_total` | Counter | `status`, `degraded` | Count of pipeline runs by final status |
| `pipeline_run_duration_ms` | Histogram | `status` | End-to-end run duration |
| `pipeline_errors_total` | Counter | `stepName` | Unhandled thrown exceptions inside steps |

---

## What to change next

- [basic.md](./basic.md) — minimal orchestrator setup before adding observers
- [degrade-vs-stop.md](./degrade-vs-stop.md) — how `result.degraded` affects the `pipeline_run_total` labels in `onRunFinish`
