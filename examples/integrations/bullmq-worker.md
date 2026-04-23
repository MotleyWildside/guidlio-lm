# BullMQ Worker Integration

Using the `GuidlioOrchestrator` inside a BullMQ job worker: mapping job lifecycle to pipeline lifecycle, propagating `job.id` as traceId, reporting per-step progress, and handling cancellation.

**Concepts covered:**
- `job.id` as pipeline `traceId` for log correlation
- Job cancellation → `AbortController` → pipeline abort
- `PipelineObserver` reporting job progress via `job.updateProgress`
- Returning `result.ctx` as the job return value
- Throwing from the job handler when the pipeline fails (so BullMQ retries at the queue level)

---

## Pipeline definition

```typescript
// src/pipeline/summarizePipeline.ts
import {
	GuidlioOrchestrator,
	GuidlioLMService,
	PipelineStep,
	StepResult,
	StepRunMeta,
	ok,
	failed,
	LoggerPipelineObserver,
	BaseContext,
	LLMTransientError,
} from "guidlio-lm";

interface SummarizeCtx extends BaseContext {
	rawText: string;
	summary?: string;
}

class SummarizeStep extends PipelineStep<SummarizeCtx> {
	readonly name = "summarize";
	constructor(private llm: GuidlioLMService) { super(); }

	async run(ctx: SummarizeCtx, meta: StepRunMeta): Promise<StepResult<SummarizeCtx>> {
		try {
			const result = await this.llm.callText({
				promptId: "summarize",
				variables: { text: ctx.rawText },
				traceId: ctx.traceId,
				signal: meta.signal,
			});
			return ok({ ctx: { ...ctx, summary: result.text } });
		} catch (err) {
			return {
				ctx,
				outcome: {
					type: "failed",
					error: err instanceof Error ? err : new Error(String(err)),
					retryable: err instanceof LLMTransientError,
				},
			};
		}
	}
}

export function createPipeline(llm: GuidlioLMService, observer: LoggerPipelineObserver) {
	return new GuidlioOrchestrator<SummarizeCtx>({
		steps: [new SummarizeStep(llm)],
		observer,
	});
}
```

---

## Progress observer

```typescript
// src/pipeline/progressObserver.ts
import type { Job } from "bullmq";
import { NoopPipelineObserver, PipelineObserver, StepOutcome } from "guidlio-lm";

export class BullMQProgressObserver extends NoopPipelineObserver implements PipelineObserver {
	private stepIndex = 0;
	private readonly totalSteps: number;

	constructor(private job: Job, totalSteps: number) {
		super();
		this.totalSteps = totalSteps;
	}

	override onStepFinish(params: { stepName: string; outcome: StepOutcome }): void {
		this.stepIndex++;
		const percent = Math.round((this.stepIndex / this.totalSteps) * 100);
		// updateProgress is fire-and-forget inside the observer — don't await
		void this.job.updateProgress(percent);
	}
}
```

---

## Worker

```typescript
// src/worker.ts
import { Worker } from "bullmq";
import Redis from "ioredis";
import { GuidlioLMService, OpenAIProvider, PromptRegistry, LoggerPipelineObserver, PipelineAbortedError } from "guidlio-lm";
import { createPipeline } from "./pipeline/summarizePipeline";
import { BullMQProgressObserver } from "./pipeline/progressObserver";

const connection = new Redis(process.env.REDIS_URL!);

// Singleton LLM service — shared across all job invocations in this worker process
const registry = new PromptRegistry();
registry.register({
	promptId: "summarize",
	version: 1,
	systemPrompt: "Summarize in at most three sentences.",
	userPrompt: "{text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});

const worker = new Worker<{ rawText: string }, { summary: string }>(
	"summarize",
	async (job) => {
		// ── Cancellation ────────────────────────────────────────────────────
		// BullMQ can signal that a job should stop (e.g., via job.moveToFailed or
		// a closing worker). Wire an AbortController to the worker's closing event.
		const controller = new AbortController();
		const abortOnClose = () => controller.abort(new Error("worker closing"));
		worker.once("closing", abortOnClose);

		try {
			const observer = new BullMQProgressObserver(job, 1 /* total steps */);
			const pipeline = createPipeline(llm, observer as unknown as LoggerPipelineObserver);

			const result = await pipeline.run(
				{
					traceId: job.id ?? crypto.randomUUID(), // correlate logs with job ID
					rawText: job.data.rawText,
				},
				{ signal: controller.signal },
			);

			if (result.status === "failed") {
				if (result.error instanceof PipelineAbortedError) {
					// Worker is closing — throw so BullMQ re-queues the job
					throw new Error("Job aborted — will be retried");
				}
				// Hard pipeline failure — throw to mark the job as failed
				throw new Error(result.error.message);
			}

			return { summary: result.ctx.summary ?? "" };
		} finally {
			worker.off("closing", abortOnClose);
		}
	},
	{
		connection,
		concurrency: 5, // up to 5 parallel jobs per worker instance
	},
);

worker.on("failed", (job, err) => {
	console.error(`Job ${job?.id} failed:`, err.message);
});
```

---

## Enqueuing jobs

```typescript
import { Queue } from "bullmq";
import Redis from "ioredis";

const queue = new Queue<{ rawText: string }>("summarize", {
	connection: new Redis(process.env.REDIS_URL!),
});

await queue.add("summarize-doc", { rawText: "A very long document..." }, {
	attempts: 3,        // BullMQ-level retries for transient failures
	backoff: { type: "exponential", delay: 1_000 },
});
```

---

## What to change next

- [basic.md](../../src/orchestrator/examples/basic.md) — minimal pipeline to understand step/policy wiring before adding job lifecycle concerns
- [abort-from-outside.md](../../src/orchestrator/examples/abort-from-outside.md) — `PipelineRunOptions.signal` and `PipelineAbortedError` handling
