# Example: OpenTelemetry Tracing Observer

Distributed tracing gives you a timeline of every step in a pipeline run, with
durations, outcomes, and error details, correlated under a single root span. This
example shows how to implement `PipelineObserver` using the `@opentelemetry/api`
package (the vendor-neutral API layer, not a concrete SDK) to open a root span
per run and a child span per step. When a step also calls `GuidlioLMService`, the
same `ctx.traceId` is passed as the LLM call's `traceId` so LLM log entries appear
in the same correlation context.

**Concepts covered:**
- `onRunStart` / `onRunFinish`: root span lifecycle
- `onStepStart` / `onStepFinish`: child span per step, stored in a `Map<string, Span>`
- `onError`: recording exceptions on the correct span
- Setting span status from `outcome.type` and `outcome.error`
- Correlating LLM calls with the pipeline's `traceId`
- Statefulness: `TracingObserver` holds open spans — create one instance per orchestrator

---

## Dependencies

```bash
npm install @opentelemetry/api
# Plus a concrete SDK for your environment, e.g.:
# npm install @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-http
```

The example imports only from `@opentelemetry/api`. The SDK is configured at
application startup — the observer code is unaware of exporters or processors.

---

## Observer

```typescript
import {
	trace,
	context,
	SpanStatusCode,
	Span,
	Tracer,
} from "@opentelemetry/api";
import {
	PipelineObserver,
	StepOutcome,
	Transition,
} from "guidlio-lm";

class TracingObserver implements PipelineObserver {
	private readonly tracer: Tracer;
	// Keyed by traceId — supports a single concurrent run per observer instance
	private rootSpans: Map<string, Span> = new Map();
	// Keyed by `${traceId}:${stepName}`
	private stepSpans: Map<string, Span> = new Map();

	constructor(serviceName: string) {
		this.tracer = trace.getTracer(serviceName);
	}

	onRunStart(params: { traceId: string }): void {
		const span = this.tracer.startSpan("pipeline.run", {
			attributes: { "pipeline.traceId": params.traceId },
		});
		this.rootSpans.set(params.traceId, span);
	}

	onRunFinish(params: { traceId: string; outcome: string; durationMs: number }): void {
		const span = this.rootSpans.get(params.traceId);
		if (!span) return;

		span.setAttributes({
			"pipeline.outcome": params.outcome,
			"pipeline.durationMs": params.durationMs,
		});

		if (params.outcome === "failed") {
			span.setStatus({ code: SpanStatusCode.ERROR });
		} else {
			span.setStatus({ code: SpanStatusCode.OK });
		}

		span.end();
		this.rootSpans.delete(params.traceId);
	}

	onStepStart(params: { traceId: string; stepName: string }): void {
		const rootSpan = this.rootSpans.get(params.traceId);

		// Start the child span inside the root span's context so it is linked
		// as a child in the trace tree
		const ctx = rootSpan
			? trace.setSpan(context.active(), rootSpan)
			: context.active();

		const span = this.tracer.startSpan(
			"pipeline.step",
			{
				attributes: {
					"pipeline.traceId": params.traceId,
					"pipeline.step": params.stepName,
				},
			},
			ctx,
		);

		this.stepSpans.set(`${params.traceId}:${params.stepName}`, span);
	}

	onStepFinish(params: {
		traceId: string;
		stepName: string;
		outcome: StepOutcome;
		durationMs: number;
	}): void {
		const key = `${params.traceId}:${params.stepName}`;
		const span = this.stepSpans.get(key);
		if (!span) return;

		span.setAttributes({
			"pipeline.step.outcome": params.outcome.type,
			"pipeline.step.durationMs": params.durationMs,
		});

		if (params.outcome.type === "failed") {
			span.setStatus({ code: SpanStatusCode.ERROR, message: params.outcome.error.message });
			span.recordException(params.outcome.error);
			if (params.outcome.statusCode !== undefined) {
				span.setAttribute("pipeline.step.statusCode", params.outcome.statusCode);
			}
		} else {
			span.setStatus({ code: SpanStatusCode.OK });
		}

		span.end();
		this.stepSpans.delete(key);
	}

	onTransition(params: {
		traceId: string;
		stepName: string;
		transition: Transition;
	}): void {
		// Annotate the root span with each routing decision — useful for debugging loops
		const rootSpan = this.rootSpans.get(params.traceId);
		if (!rootSpan) return;

		const dest =
			params.transition.type === "goto" || params.transition.type === "retry"
				? params.transition.stepName ?? ""
				: "";

		rootSpan.addEvent("pipeline.transition", {
			"from": params.stepName,
			"transition": params.transition.type,
			"to": dest,
		});
	}

	onError(params: { traceId: string; stepName?: string; error: Error }): void {
		if (params.stepName) {
			// Step-level error — record on the step span if it is still open
			const span = this.stepSpans.get(`${params.traceId}:${params.stepName}`);
			if (span) {
				span.recordException(params.error);
				return;
			}
		}
		// Run-level error — record on the root span
		const span = this.rootSpans.get(params.traceId);
		span?.recordException(params.error);
	}
}
```

---

## Context and LLM correlation

Pass `ctx.traceId` to every `GuidlioLMService` call so LLM log entries carry the
same correlation key as the pipeline spans. The LLM service logs it alongside model
name and token counts, giving you a single string to grep in your log aggregator.

```typescript
import { BaseContext } from "guidlio-lm";

interface ProcessContext extends BaseContext {
	documentId: string;
	analysis?: string;
}
```

```typescript
import { PipelineStep, StepResult, StepRunMeta, ok, failed, GuidlioLMService, LLMTransientError } from "guidlio-lm";

class AnalyzeStep extends PipelineStep<ProcessContext> {
	readonly name = "analyze";

	constructor(private readonly llm: GuidlioLMService) {
		super();
	}

	async run(ctx: ProcessContext, meta: StepRunMeta): Promise<StepResult<ProcessContext>> {
		try {
			const result = await this.llm.callText({
				model: "gpt-4o",
				messages: [{ role: "user", content: `Analyze document ${ctx.documentId}` }],
				signal: meta.signal,
				// Pass the pipeline's traceId — the LLM service includes it in log output,
				// so all LLM calls made during this run appear under the same trace key
				traceId: ctx.traceId,
			});
			return ok({ ctx: { ...ctx, analysis: result.text } });
		} catch (err) {
			return failed({
				ctx,
				error: err instanceof Error ? err : new Error(String(err)),
				retryable: err instanceof LLMTransientError,
			});
		}
	}
}
```

---

## Wiring

`TracingObserver` is stateful — it holds open `Span` objects between `onStepStart`
and `onStepFinish`. Create one instance per `GuidlioOrchestrator` instantiation.
For concurrent pipelines running in the same process, each orchestrator should have
its own observer, or you must ensure the `traceId` is unique per run (it always is
when you let the orchestrator generate it or pass a UUID).

```typescript
import { GuidlioOrchestrator, RetryPolicy } from "guidlio-lm";

// Create one observer per orchestrator — not one per run
const tracingObserver = new TracingObserver("my-service");

const orchestrator = new GuidlioOrchestrator<ProcessContext>({
	steps: [new AnalyzeStep(llm)],
	observer: tracingObserver,
	policy: () => new RetryPolicy({ maxAttempts: 2 }),
});
```

---

## Running

```typescript
const result = await orchestrator.run(
	{ traceId: "run-abc123", documentId: "doc-99" },
	// Pass a traceId — if omitted the orchestrator generates a UUID
);

// The OTLP exporter (configured at startup) sends spans to your tracing backend.
// In Jaeger/Zipkin/Honeycomb you will see:
//   pipeline.run  (root, traceId = "run-abc123")
//     └── pipeline.step  (stepName = "analyze")
```

---

## SDK setup (outside this observer)

The observer is unaware of how spans are exported. Configure the SDK once at
application startup:

```typescript
// tracing.ts — loaded before any other module

import { NodeSDK } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const sdk = new NodeSDK({
	traceExporter: new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" }),
});
sdk.start();
```

---

## What to change next

- Use `LoggerPipelineObserver` for simpler structured logging without OTel: `../basic.md`
- Combine tracing with retry logic to see retries as sibling spans: `../retry-with-backoff.md`
