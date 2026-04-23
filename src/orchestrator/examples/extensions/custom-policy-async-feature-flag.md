# Example: Async Feature-Flag Policy

Feature flags let you roll out pipeline changes gradually — routing some users
through a new branch while others take the stable path. Because a flag lookup is
typically an async I/O call (HTTP, Redis, SDK), this example shows how to override
`decide()` — the top-level policy method — to return a `Promise`, and how to
selectively intercept one step's `ok` outcome while delegating everything else to
`super.decide()`.

**Concepts covered:**
- `decide()` override returning `Promise<PolicyDecisionOutput<C>>`
- Awaiting an external flag service inside the policy
- Degrading the run when the flag is disabled for a specific user
- Delegating to `super.decide()` for all other steps and outcomes
- The orchestrator accepts both sync and async return values from `decide()`

---

## Feature flag service interface

This example uses a minimal interface. Any feature flag SDK (LaunchDarkly,
Unleash, CloudBees, a homemade HTTP client) fits as long as it exposes an
`isEnabled` async method.

```typescript
// flags.ts

export interface FeatureFlagService {
	isEnabled(flag: string, userId: string): Promise<boolean>;
}
```

---

## Context

```typescript
import { BaseContext } from "guidlio-lm";

interface IngestionContext extends BaseContext {
	userId: string;
	documentId: string;
	parsedContent?: string;
	enrichedMetadata?: Record<string, unknown>;
}
```

---

## Policy

`decide()` is called after every step. For the `"parse"` step's `ok` outcome,
the policy checks whether the `"new-enrichment-flow"` flag is enabled for the
current user. If not, it degrades immediately instead of proceeding to the
enrichment step. For everything else — other steps, `failed` outcomes, `redirect`
outcomes — it delegates to `super.decide()`.

```typescript
import {
	DefaultPolicy,
	PolicyDecisionInput,
	PolicyDecisionOutput,
	BaseContext,
} from "guidlio-lm";
import { FeatureFlagService } from "./flags";

class FeatureFlagPolicy extends DefaultPolicy<IngestionContext> {
	private readonly flags: FeatureFlagService;

	constructor(flags: FeatureFlagService) {
		super();
		this.flags = flags;
	}

	override async decide(
		input: PolicyDecisionInput<IngestionContext>,
	): Promise<PolicyDecisionOutput<IngestionContext>> {
		const { stepName, stepResult } = input;

		// Only intercept the "parse" step on a successful outcome
		if (stepName === "parse" && stepResult.outcome.type === "ok") {
			const enabled = await this.flags.isEnabled(
				"new-enrichment-flow",
				stepResult.ctx.userId,
			);

			if (!enabled) {
				// Skip the enrichment step entirely for this user
				return {
					transition: {
						type: "degrade",
						reason: "new-enrichment-flow disabled for this user",
					},
				};
			}
		}

		// All other steps and outcomes: default behaviour (ok → next, failed → fail, etc.)
		return super.decide(input);
	}
}
```

The return type annotation is `Promise<PolicyDecisionOutput<...>>`. The interface
declares `PolicyDecisionOutput | Promise<PolicyDecisionOutput>`, so both sync and
async overrides satisfy it — you do not need a wrapper.

---

## Steps

```typescript
import { PipelineStep, StepResult, StepRunMeta, ok, failed } from "guidlio-lm";

class ParseStep extends PipelineStep<IngestionContext> {
	readonly name = "parse";

	async run(ctx: IngestionContext, meta: StepRunMeta): Promise<StepResult<IngestionContext>> {
		try {
			const parsedContent = await parser.parse(ctx.documentId, { signal: meta.signal });
			return ok({ ctx: { ...ctx, parsedContent } });
		} catch (err) {
			return failed({
				ctx,
				error: err instanceof Error ? err : new Error(String(err)),
				retryable: true,
			});
		}
	}
}

class EnrichStep extends PipelineStep<IngestionContext> {
	readonly name = "enrich";

	async run(ctx: IngestionContext, meta: StepRunMeta): Promise<StepResult<IngestionContext>> {
		const enrichedMetadata = await enricher.run(ctx.parsedContent ?? "", {
			signal: meta.signal,
		});
		return ok({ ctx: { ...ctx, enrichedMetadata } });
	}
}

class StoreStep extends PipelineStep<IngestionContext> {
	readonly name = "store";

	async run(ctx: IngestionContext, _meta: StepRunMeta): Promise<StepResult<IngestionContext>> {
		await storage.save(ctx.documentId, ctx.parsedContent, ctx.enrichedMetadata);
		return ok({ ctx });
	}
}
```

---

## Wiring

`FeatureFlagPolicy` does not hold per-run mutable state, so the same instance can
be reused across sequential runs. For concurrent runs, use a factory.

```typescript
import { GuidlioOrchestrator } from "guidlio-lm";
import { FeatureFlagPolicy } from "./policy";
import { launchDarklyClient } from "./flags";

const flagPolicy = new FeatureFlagPolicy(launchDarklyClient);

const orchestrator = new GuidlioOrchestrator<IngestionContext>({
	steps: [new ParseStep(), new EnrichStep(), new StoreStep()],
	policy: flagPolicy,
});
```

---

## Running

```typescript
// User with the flag enabled — runs the full pipeline
const enabled = await orchestrator.run({
	traceId: "ingest-001",
	userId: "user-beta-42",
	documentId: "doc-X",
});
if (enabled.status === "ok" && !enabled.degraded) {
	console.log("Enriched metadata:", enabled.ctx.enrichedMetadata);
}

// User without the flag — pipeline degrades after parse, skipping enrich
const disabled = await orchestrator.run({
	traceId: "ingest-002",
	userId: "user-stable-99",
	documentId: "doc-Y",
});
if (disabled.status === "ok" && disabled.degraded) {
	console.log("Degraded:", disabled.degraded.reason);
	// "new-enrichment-flow disabled for this user"
	// ctx.parsedContent is available; ctx.enrichedMetadata is undefined
}
```

---

## Handling flag service errors

If the flag lookup itself throws, the `decide()` call will reject and the
orchestrator will propagate the error as a pipeline failure. To make the flag
lookup non-fatal, catch it and default to the safe path:

```typescript
override async decide(
	input: PolicyDecisionInput<IngestionContext>,
): Promise<PolicyDecisionOutput<IngestionContext>> {
	if (input.stepName === "parse" && input.stepResult.outcome.type === "ok") {
		let enabled = false;
		try {
			enabled = await this.flags.isEnabled("new-enrichment-flow", input.stepResult.ctx.userId);
		} catch {
			// Flag service unavailable — default to disabled (safe path)
			enabled = false;
		}
		if (!enabled) {
			return { transition: { type: "degrade", reason: "new-enrichment-flow disabled" } };
		}
	}
	return super.decide(input);
}
```

---

## What to change next

- Route by context value without async I/O: `./custom-policy-conditional-routing.md`
- Compose async policy logic with retry behaviour: `./custom-policy-composing.md`
