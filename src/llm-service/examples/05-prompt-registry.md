# Prompt Registry

`PromptRegistry` stores versioned prompt definitions and interpolates `{variable}` placeholders into messages before each call. You can inject a pre-populated registry at service construction time, or access `llm.promptRegistry` after construction to register prompts dynamically.

## Anatomy of a PromptDefinition

```typescript
import { PromptRegistry } from "guidlio-lm";

const registry = new PromptRegistry();

registry.register({
	// ── Identity ──────────────────────────────
	promptId: "classify-ticket",
	version: 2,                   // number or string; numeric versions compared numerically

	// ── Message templates ─────────────────────
	systemPrompt: "You are a customer support classifier.",
	// developer: "..."           // alternate system role (useful for some providers)
	userPrompt: "Classify this ticket:\n\n{body}\n\nCategories: {categories}",

	// ── Model defaults ────────────────────────
	modelDefaults: {
		model: "gpt-4o-mini",
		temperature: 0,
		maxTokens: 128,
		topP: 1,
	},

	// ── Output ───────────────────────────────
	output: {
		type: "json",             // "text" | "json"
		schema: CategorySchema,   // optional Zod schema; validated in callJSON
	},
});
```

## Versioning

Multiple versions of the same `promptId` can coexist. `getPrompt` with no version returns the latest one (highest numeric value, then lexicographic).

```typescript
registry.register({ promptId: "draft", version: 1, /* ... */ });
registry.register({ promptId: "draft", version: 2, /* ... */ });
registry.register({ promptId: "draft", version: "2024-11-01", /* ... */ });

// Calling without version → latest
await llm.callText({ promptId: "draft", variables: { text } });

// Pinning to a specific version
await llm.callText({ promptId: "draft", promptVersion: 1, variables: { text } });
```

## Variable interpolation

`{variableName}` placeholders are replaced in both `systemPrompt` and `userPrompt`. Rules:

- String / number / boolean → converted to string directly.
- Object / array → `JSON.stringify`'d.
- `null` → `"null"`.
- Missing variable → left as the literal `{variableName}` (no error thrown).

```typescript
registry.register({
	promptId: "report",
	version: 1,
	systemPrompt: "You are an analyst for {company}.",
	userPrompt: "Analyse these metrics: {metrics}",
	modelDefaults: { model: "gpt-4o" },
	output: { type: "text" },
});

await llm.callText({
	promptId: "report",
	variables: {
		company: "Acme Corp",
		metrics: { revenue: 1_200_000, churn: 0.03 },  // object → JSON string
	},
});
```

## Inspecting and clearing the registry

```typescript
// All registered prompts (useful for debugging / admin UIs)
const all = registry.getAllPrompts();
console.log(all.map((p) => `${p.promptId}@${p.version}`));

// Clear everything (common in test setup/teardown)
registry.clear();
```

## Loading prompts from a file at startup

```typescript
import { readFileSync } from "fs";
import type { PromptDefinition } from "guidlio-lm";

const definitions: PromptDefinition[] = JSON.parse(
	readFileSync("prompts.json", "utf-8"),
);

const registry = new PromptRegistry();
for (const def of definitions) {
	registry.register(def);
}

const llm = new LLMService({ providers: [...], promptRegistry: registry });
```

> Note: `PromptDefinition.output.schema` must be a Zod schema instance — it cannot be serialized to JSON. Either register schema-less definitions from file and attach schemas in code, or omit `schema` and pass `jsonSchema` per-call.
