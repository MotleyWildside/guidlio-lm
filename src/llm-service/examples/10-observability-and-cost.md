# Observability and Cost Tracking

Every LLM call emits a structured log entry with timing, token usage, cache status, and provider metadata. Wiring a logger — or adapting these entries to your existing observability stack — gives you per-prompt latency, cost attribution, and retry visibility without any extra instrumentation code.

**Concepts covered:**
- Injecting `ConsoleLogger` or a custom `LLMLogger`
- The shape of a `llmCall` log entry
- Distinguishing terminal log entries from mid-flight retry entries
- Aggregating `usage.totalTokens` across a batch
- An OpenTelemetry-style adapter skeleton

---

## Injecting a logger

```typescript
import { GuidlioLMService, OpenAIProvider, ConsoleLogger, PromptRegistry } from "guidlio-lm";

const registry = new PromptRegistry();

registry.register({
	promptId: "summarize",
	version: 1,
	systemPrompt: "You are a concise summarizer.",
	userPrompt: "Summarize: {text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	logger: new ConsoleLogger(),
	promptRegistry: registry,
});

await llm.callText({ promptId: "summarize", variables: { text: "..." } });
// Logs to stdout:
// {
//   llmCall: {
//     traceId: "trace_abc123",
//     promptId: "summarize",
//     promptVersion: 1,
//     model: "gpt-4o-mini",
//     provider: "openai",
//     success: true,
//     cached: false,
//     durationMs: 384,
//     usage: { promptTokens: 48, completionTokens: 32, totalTokens: 80 }
//   }
// }
```

---

## Log entry shape

Every log entry is emitted at `info` level and carries a `llmCall` field:

```typescript
interface LLMCallLogMeta {
	traceId: string;
	promptId: string;
	promptVersion: string | number;
	model: string;
	provider: string;
	success: boolean;
	cached: boolean;
	durationMs: number;
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
	// Present only on mid-flight retry entries:
	retry?: true;
}
```

---

## Terminal entries vs retry entries

When the service retries a call, it emits one log entry **per attempt**. The mid-flight entries have `retry: true` and `success: false`. The terminal entry — whether the final attempt succeeded or failed — has no `retry` field.

```
attempt 1 → fail  →  { success: false, retry: true,  durationMs: 312 }
attempt 2 → fail  →  { success: false, retry: true,  durationMs: 289 }
attempt 3 → ok    →  { success: true,                durationMs: 401 }
```

Filter on `!meta.retry` to get one aggregated record per logical call. Filter on `meta.retry === true` to count or alert on retry frequency.

```typescript
import type { LLMLogger } from "guidlio-lm";

class FilteringLogger implements LLMLogger {
	info(message: string, meta?: Record<string, unknown>): void {
		const call = meta?.["llmCall"] as LLMCallLogMeta | undefined;
		if (call?.retry) {
			// Mid-flight retry — count it but don't record as a completed call
			retryCounter.increment({ model: call.model });
			return;
		}
		// Terminal entry — record cost and latency
		if (call) {
			metricsStore.record({
				model: call.model,
				totalTokens: call.usage?.totalTokens ?? 0,
				durationMs: call.durationMs,
				success: call.success,
			});
		}
	}

	warn(message: string, meta?: Record<string, unknown>): void {
		console.warn(message, meta);
	}

	error(message: string, meta?: Record<string, unknown>): void {
		console.error(message, meta);
	}
}
```

---

## Aggregating token usage across a batch

Collect `usage.totalTokens` from each result and reduce to a total. Use this for per-job cost attribution or to enforce a budget cap.

```typescript
async function summarizeBatch(articles: string[]): Promise<{ texts: string[]; totalTokens: number }> {
	const results = await Promise.all(
		articles.map((text) =>
			llm.callText({
				promptId: "summarize",
				variables: { text },
			}),
		),
	);

	const totalTokens = results.reduce(
		(sum, r) => sum + (r.usage?.totalTokens ?? 0),
		0,
	);

	return { texts: results.map((r) => r.text), totalTokens };
}

const { texts, totalTokens } = await summarizeBatch(myArticles);
console.log(`Processed ${myArticles.length} articles, used ${totalTokens} tokens`);
// Roughly $0.15 / 1M tokens for gpt-4o-mini → multiply for cost estimate
```

---

## OpenTelemetry-style adapter

Implement `LLMLogger` and translate each entry into an OTel span. The example shows the structural wiring — fill in the actual OTel SDK calls for your runtime.

```typescript
import type { LLMLogger } from "guidlio-lm";

// Placeholder types — replace with your actual OTel SDK imports
interface Tracer {
	startActiveSpan<T>(name: string, fn: (span: Span) => T): T;
}
interface Span {
	setAttribute(key: string, value: string | number | boolean): void;
	setStatus(status: { code: number }): void;
	end(): void;
}

// LLM call log entries carry all the attributes needed for a meaningful span
class OtelLLMLogger implements LLMLogger {
	constructor(private readonly tracer: Tracer) {}

	info(message: string, meta?: Record<string, unknown>): void {
		const call = meta?.["llmCall"] as Record<string, unknown> | undefined;
		if (!call) return;

		// Each terminal log entry becomes an OTel span
		if (!call["retry"]) {
			this.tracer.startActiveSpan("llm.call", (span) => {
				span.setAttribute("llm.provider", String(call["provider"] ?? ""));
				span.setAttribute("llm.model", String(call["model"] ?? ""));
				span.setAttribute("llm.prompt_id", String(call["promptId"] ?? ""));
				span.setAttribute("llm.cached", Boolean(call["cached"]));
				span.setAttribute("llm.duration_ms", Number(call["durationMs"] ?? 0));
				span.setAttribute(
					"llm.tokens.total",
					Number((call["usage"] as Record<string, unknown> | undefined)?.["totalTokens"] ?? 0),
				);
				span.setAttribute(
					"llm.tokens.prompt",
					Number((call["usage"] as Record<string, unknown> | undefined)?.["promptTokens"] ?? 0),
				);
				span.setAttribute(
					"llm.tokens.completion",
					Number((call["usage"] as Record<string, unknown> | undefined)?.["completionTokens"] ?? 0),
				);
				// OTel status codes: 0 = unset, 1 = ok, 2 = error
				span.setStatus({ code: call["success"] ? 1 : 2 });
				span.end();
			});
		}
	}

	warn(message: string, _meta?: Record<string, unknown>): void {
		// Route to your OTel event or log bridge
		console.warn("[llm warn]", message);
	}

	error(message: string, _meta?: Record<string, unknown>): void {
		console.error("[llm error]", message);
	}
}

// Usage
const llmWithOtel = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	logger: new OtelLLMLogger(myTracer),
	promptRegistry: registry,
});
```

---

## What to change next

- [11-retry-tuning.md](./11-retry-tuning.md) — adjust retry behavior and understand how mid-flight retry log entries relate to `maxAttempts`
- [07-providers-and-errors.md](./07-providers-and-errors.md) — full error type reference for distinguishing transient vs permanent failures in log handlers
