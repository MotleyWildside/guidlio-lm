# Structured Extraction with Orchestrator-Level Retry

Messy user input — copy-pasted invoice text, multi-language form submissions, OCR output — often produces malformed JSON that passes the parse step but fails schema validation. `GuidlioLMService` automatically retries `LLMTransientError` (network issues, rate limits), but it does not retry `LLMSchemaError`. This recipe shows how to catch a schema mismatch at the orchestrator level and automatically re-run extraction with a repair hint that tells the model exactly what it got wrong.

**Concepts covered:**
- Orchestrator-level retry on `LLMSchemaError` (distinct from service-level transient retry)
- `redirect` outcome to branch from the extract step into a repair step
- `RedirectRoutingPolicy` for declarative routing between steps
- Catching `LLMSchemaError` and `LLMParseError` with different outcomes
- Threading error details through context to improve the repair prompt

---

## Context

```typescript
import { BaseContext } from "guidlio-lm";

interface ExtractionContext extends BaseContext {
	rawText: string;
	extracted?: InvoiceData;
	extractionError?: string;
	repairHint?: string;
}

interface InvoiceData {
	invoiceNumber: string;
	totalAmount: number;
	currency: string;
	lineItems: Array<{ description: string; quantity: number; unitPrice: number }>;
}
```

---

## Schema and prompts

```typescript
import { z } from "zod";
import {
	GuidlioLMService,
	OpenAIProvider,
	PromptRegistry,
} from "guidlio-lm";

const InvoiceSchema = z.object({
	invoiceNumber: z.string().min(1),
	totalAmount: z.number().positive(),
	currency: z.string().length(3),
	lineItems: z.array(
		z.object({
			description: z.string().min(1),
			quantity: z.number().positive(),
			unitPrice: z.number().nonnegative(),
		}),
	),
});

const registry = new PromptRegistry();

registry.register({
	promptId: "extract_invoice",
	version: 1,
	systemPrompt:
		"You extract structured invoice data from raw text. " +
		"Return only valid JSON matching the requested schema. " +
		"If a field is missing from the source text, omit it or use a sensible default.",
	userPrompt: "Extract invoice data from the following text:\n\n{rawText}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0 },
	output: { type: "json" },
});

registry.register({
	promptId: "repair_invoice",
	version: 1,
	systemPrompt:
		"You extract structured invoice data from raw text. " +
		"A previous extraction attempt failed validation. " +
		"Return only valid JSON that fixes the reported problems.",
	userPrompt:
		"Extract invoice data from the following text:\n\n{rawText}\n\n" +
		"The previous attempt produced this error: {repairHint}\n\n" +
		"Fix those issues and return a corrected JSON object.",
	modelDefaults: { model: "gpt-4o", temperature: 0 },
	output: { type: "json" },
});

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});
```

---

## Steps

```typescript
import {
	PipelineStep,
	StepResult,
	StepRunMeta,
	ok,
	failed,
	redirect,
	LLMSchemaError,
	LLMParseError,
} from "guidlio-lm";

class ExtractStep extends PipelineStep<ExtractionContext> {
	readonly name = "extract";

	constructor(private readonly llmSvc: GuidlioLMService) {
		super();
	}

	async run(ctx: ExtractionContext, meta: StepRunMeta): Promise<StepResult<ExtractionContext>> {
		try {
			const result = await this.llmSvc.callJSON<InvoiceData>({
				promptId: "extract_invoice",
				variables: { rawText: ctx.rawText },
				jsonSchema: InvoiceSchema,
				signal: meta.signal,
			});
			return ok({ ctx: { ...ctx, extracted: result.data } });
		} catch (err) {
			if (err instanceof LLMSchemaError) {
				// Zod validated but the shape was wrong — the repair prompt can fix this
				const hint = err.validationErrors
					.map((e) => `${e.path.join(".")}: ${e.message}`)
					.join("; ");
				return redirect({
					ctx: { ...ctx, extractionError: err.message, repairHint: hint },
					message: "repair",
				});
			}
			if (err instanceof LLMParseError) {
				// Model returned prose — no point retrying with the repair prompt
				return failed({
					ctx: { ...ctx, extractionError: "Model returned unparseable output" },
					error: err,
					retryable: false,
				});
			}
			throw err; // unexpected errors bubble up
		}
	}
}

class RepairStep extends PipelineStep<ExtractionContext> {
	readonly name = "repair";

	constructor(private readonly llmSvc: GuidlioLMService) {
		super();
	}

	async run(ctx: ExtractionContext, meta: StepRunMeta): Promise<StepResult<ExtractionContext>> {
		try {
			const result = await this.llmSvc.callJSON<InvoiceData>({
				promptId: "repair_invoice",
				variables: {
					rawText: ctx.rawText,
					repairHint: ctx.repairHint ?? "Unknown validation error",
				},
				jsonSchema: InvoiceSchema,
				signal: meta.signal,
			});
			return ok({ ctx: { ...ctx, extracted: result.data } });
		} catch (err) {
			return failed({
				ctx,
				error: err instanceof Error ? err : new Error(String(err)),
				retryable: false,
			});
		}
	}
}
```

---

## Wiring

```typescript
import { GuidlioOrchestrator, RedirectRoutingPolicy } from "guidlio-lm";

const orchestrator = new GuidlioOrchestrator<ExtractionContext>({
	steps: [new ExtractStep(llm), new RepairStep(llm)],
	// redirect({ message: "repair" }) from ExtractStep routes to the repair step.
	// If RepairStep returns ok(), the pipeline stops with status "ok".
	// If RepairStep returns failed(), the pipeline stops with status "failed".
	policy: () =>
		new RedirectRoutingPolicy({
			repair: "repair",
		}),
	maxTransitions: 10,
});
```

---

## Running

```typescript
const messyInvoice = `
  Invoice #INV-2024-001
  Total: one thousand two hundred dollars
  Items: consulting services
`;

const result = await orchestrator.run({
	traceId: crypto.randomUUID(),
	rawText: messyInvoice,
});

if (result.status === "ok") {
	const data = result.ctx.extracted!;
	console.log("Invoice number:", data.invoiceNumber);
	console.log("Total:", data.totalAmount, data.currency);
	console.log("Line items:", data.lineItems.length);
} else {
	console.error("Extraction failed:", result.error.message);
}
```

---

## Why this is different from service-level retry

`GuidlioLMService` retry only fires on `LLMTransientError` — network timeouts, 429 rate limits, and 5xx responses. A `LLMSchemaError` means the model responded successfully but produced the wrong structure: retrying with the same prompt would likely produce the same wrong structure. The orchestrator-level repair pattern is more effective because it changes the prompt to include the validation feedback, giving the model a concrete description of what to fix.

---

## What to change next

- [Providers and errors](../src/llm-service/examples/07-providers-and-errors.md) — full error taxonomy and retry configuration
- [Agent with tools](agent-with-tools.md) — a more complex multi-step redirect loop
