# Degrade vs Stop

Both `stop` and `degrade` transitions end the pipeline with `status: "ok"`. The difference is that `degrade` also sets `result.degraded = { reason }` on the run result, giving the caller a machine-readable signal that the pipeline completed but did not fully achieve its goal. Use it for graceful partial failures rather than clean completions.

**Concepts covered:**
- `stop`: clean completion, goal fully achieved
- `degrade`: partial success — pipeline did real work, but the goal was only partially met
- `fail`: not degrade — use when the pipeline cannot produce any useful output
- Reading `result.degraded.reason` at the call site
- Example: a summarizer that times out on step 3 of 4 and returns a partial result

---

## stop vs degrade vs fail

| Transition | `result.status` | `result.degraded` | When to use |
| :--- | :--- | :--- | :--- |
| `stop` | `"ok"` | `undefined` | Pipeline achieved its goal cleanly |
| `degrade` | `"ok"` | `{ reason: string }` | Pipeline produced partial/degraded output — caller should inspect it |
| `fail` | `"failed"` | — | Pipeline cannot produce useful output; treat as an error |

**Rule of thumb:** if `result.ctx` contains something the caller can use (even partially), prefer `degrade` over `fail`. Reserve `fail` for auth errors, bad input, configuration issues, or any state where proceeding would produce no value.

---

## Example: 4-step summarizer

A pipeline that fetches, preprocesses, summarizes, and formats an article. Steps 3 and 4 are best-effort: if step 3 (summarize) times out, the pipeline returns what it has from steps 1–2 rather than failing entirely.

### Context

```typescript
import { BaseContext } from "guidlio-lm";

interface ArticleContext extends BaseContext {
	articleId: string;
	rawText?: string;
	cleanedText?: string;
	summary?: string;
	formattedOutput?: string;
}
```

### Steps

```typescript
import {
	PipelineStep,
	StepResult,
	StepRunMeta,
	ok,
	failed,
} from "guidlio-lm";

class FetchArticleStep extends PipelineStep<ArticleContext> {
	readonly name = "fetch-article";

	async run(ctx: ArticleContext, _meta: StepRunMeta): Promise<StepResult<ArticleContext>> {
		const rawText = await articleDb.fetch(ctx.articleId);
		if (!rawText) {
			return failed({
				ctx,
				error: new Error(`Article ${ctx.articleId} not found`),
				retryable: false,
				statusCode: 404,
			});
		}
		return ok({ ctx: { ...ctx, rawText } });
	}
}

class PreprocessStep extends PipelineStep<ArticleContext> {
	readonly name = "preprocess";

	async run(ctx: ArticleContext, _meta: StepRunMeta): Promise<StepResult<ArticleContext>> {
		const cleanedText = stripHtml(ctx.rawText ?? "");
		return ok({ ctx: { ...ctx, cleanedText } });
	}
}

class SummarizeStep extends PipelineStep<ArticleContext> {
	readonly name = "summarize";

	async run(ctx: ArticleContext, meta: StepRunMeta): Promise<StepResult<ArticleContext>> {
		try {
			const summary = await llm.callText({
				promptId: "summarize",
				variables: { text: ctx.cleanedText ?? "" },
				signal: meta.signal, // cancelled when stepTimeoutMs fires
			});
			return ok({ ctx: { ...ctx, summary: summary.text } });
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				// Return failed so the policy can choose to degrade instead of failing
				return failed({
					ctx,
					error: new Error("Summarize step timed out"),
					retryable: false,
				});
			}
			return failed({
				ctx,
				error: err instanceof Error ? err : new Error(String(err)),
				retryable: true,
			});
		}
	}
}

class FormatOutputStep extends PipelineStep<ArticleContext> {
	readonly name = "format-output";

	async run(ctx: ArticleContext, _meta: StepRunMeta): Promise<StepResult<ArticleContext>> {
		const formattedOutput = formatter.render({
			title: ctx.articleId,
			body: ctx.summary ?? ctx.cleanedText ?? ctx.rawText ?? "",
		});
		return ok({ ctx: { ...ctx, formattedOutput } });
	}
}
```

### Policy: degrade on summarize timeout

```typescript
import {
	DefaultPolicy,
	PolicyDecisionInput,
	PolicyDecisionOutput,
} from "guidlio-lm";

class ArticleSummaryPolicy extends DefaultPolicy<ArticleContext> {
	override async decide(
		input: PolicyDecisionInput<ArticleContext>,
	): Promise<PolicyDecisionOutput<ArticleContext>> {
		const { stepName, stepResult } = input;
		const { outcome } = stepResult;

		// If summarize fails (e.g. timed out), skip to format-output with what we have
		// rather than failing the whole request — the caller gets the cleaned text as fallback
		if (
			stepName === "summarize" &&
			outcome.type === "failed" &&
			outcome.error.message === "Summarize step timed out"
		) {
			return {
				transition: {
					type: "degrade",
					reason: "Summarize step timed out — returning cleaned text without summary",
				},
			};
		}

		return super.decide(input);
	}
}
```

### Wiring and reading the result

```typescript
import { GuidlioOrchestrator } from "guidlio-lm";

const orchestrator = new GuidlioOrchestrator<ArticleContext>({
	steps: [
		new FetchArticleStep(),
		new PreprocessStep(),
		new SummarizeStep(),
		new FormatOutputStep(),
	],
	policy: () => new ArticleSummaryPolicy(),
	stepTimeoutMs: 8_000, // 8 s per step
});

const result = await orchestrator.run({
	traceId: "article-run-001",
	articleId: "post-42",
});

if (result.status === "ok") {
	if (result.degraded) {
		// Partial success — log the reason and return whatever we have
		console.warn("Pipeline degraded:", result.degraded.reason);
		// result.ctx.summary is undefined; result.ctx.cleanedText is available
		res.json({
			text: result.ctx.cleanedText,
			degraded: true,
			degradedReason: result.degraded.reason,
		});
	} else {
		// Clean success — full summary available
		res.json({ text: result.ctx.formattedOutput });
	}
} else {
	// Genuine failure — article not found, auth error, etc.
	console.error("Pipeline failed:", result.error.message, result.error.statusCode);
	res.status(result.error.statusCode ?? 500).json({ error: result.error.message });
}
```

---

## Degrade at the policy level vs inside a step

The `degrade` transition is a policy-level decision. Steps do not decide to degrade — they return an outcome (`ok`, `failed`, or `redirect`) and the policy maps that to a transition. This separation means:

- Steps stay focused on their own work and do not need to know about the degradation strategy
- The policy can change the degradation threshold (e.g., allow 2 summarize timeouts before degrading) without touching any step code

---

## What to change next

- [context-adjustments.md](./context-adjustments.md) — combine a `degrade` transition with a `patch` adjustment to record a `degradedAt` field in the context for downstream logging
- [observer-metrics.md](./observer-metrics.md) — emit a separate `pipeline_run_total` counter label for `degraded: true` to distinguish degraded ok from clean ok in your dashboards
