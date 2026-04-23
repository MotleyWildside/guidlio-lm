# Prompt Registry — Loading from External Sources

In production you often want to maintain prompt definitions outside the application binary: in a JSON file checked into a content repository, in a database, or served by an internal API. This example covers three patterns for externalising prompts and one pattern for keeping them live without a restart.

## Concepts covered

- Loading `PromptDefinition` objects from a local JSON file at startup
- Loading from an HTTP endpoint at startup (async)
- Hot-reload: swapping the active registry on a background interval so the service picks up new prompts without a restart
- Why `output.schema` (Zod) must be attached in code after deserialising from JSON
- Injecting the registry via `GuidlioLMServiceConfig.promptRegistry`

## 1. Loading from a JSON file at startup

Keep prompt templates in a file that can be edited and deployed separately from application code.

**`prompts.json`** (stored alongside your app, or fetched from a content repo):

```json
[
  {
    "promptId": "summarize",
    "version": 1,
    "systemPrompt": "Summarize the following text in one paragraph.",
    "userPrompt": "{text}",
    "modelDefaults": { "model": "gpt-4o-mini", "temperature": 0.3 }
  },
  {
    "promptId": "classify",
    "version": 1,
    "systemPrompt": "Classify the intent of the user message.",
    "userPrompt": "{message}",
    "modelDefaults": { "model": "gpt-4o-mini", "temperature": 0 }
  }
]
```

**Loader code:**

```typescript
import { readFileSync } from "fs";
import { z } from "zod";
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";
import type { PromptDefinition } from "guidlio-lm";

// JSON-parsed definitions lack the Zod schema instance — attach them in code
const ClassifyOutputSchema = z.object({
	intent: z.string(),
	confidence: z.number(),
});

// Read and parse the file synchronously at module load time.
// If the file is missing or malformed the process fails immediately with a clear error.
const rawDefinitions = JSON.parse(
	readFileSync(new URL("./prompts.json", import.meta.url), "utf-8"),
) as Array<Omit<PromptDefinition, "output"> & { output?: { type: string } }>;

const registry = new PromptRegistry();

for (const def of rawDefinitions) {
	if (def.promptId === "classify") {
		// Attach the Zod schema that cannot be expressed in JSON
		registry.register({
			...def,
			output: { type: "json", schema: ClassifyOutputSchema },
		} as PromptDefinition);
	} else {
		registry.register({
			...def,
			output: { type: "text" },
		} as PromptDefinition);
	}
}

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});
```

> `PromptDefinition.output.schema` must be a Zod schema instance. JSON has no representation for executable code, so always attach schemas in code after loading definitions from any serialised source.

## 2. Loading from an HTTP endpoint at startup

Use this when a central service owns prompt versions and pushes them to all consumers.

```typescript
import { z } from "zod";
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";
import type { PromptDefinition } from "guidlio-lm";

const SentimentSchema = z.object({ sentiment: z.enum(["positive", "negative", "neutral"]) });

// Schema map: keyed by promptId, values are Zod schemas to attach after fetch
const schemaMap: Record<string, z.ZodSchema<unknown>> = {
	"sentiment-analysis": SentimentSchema,
};

async function loadRegistryFromApi(apiUrl: string): Promise<PromptRegistry> {
	const response = await fetch(`${apiUrl}/prompts`);

	if (!response.ok) {
		throw new Error(`Failed to load prompts from API: HTTP ${response.status}`);
	}

	const definitions = (await response.json()) as Array<
		Omit<PromptDefinition, "output"> & { output: { type: string } }
	>;

	const registry = new PromptRegistry();

	for (const def of definitions) {
		const schema = schemaMap[def.promptId];
		registry.register({
			...def,
			output: {
				type: def.output.type as "text" | "json",
				schema,
			},
		} as PromptDefinition);
	}

	return registry;
}

// Await at startup — the service is not constructed until prompts are loaded
const registry = await loadRegistryFromApi(process.env.PROMPTS_API_URL!);

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});
```

## 3. Hot-reload without a restart

Export a `getRegistry()` getter backed by a module-level variable. A background interval refetches definitions and atomically replaces the variable. Each call to the service passes `getRegistry()` so it always uses the current version.

```typescript
import { z } from "zod";
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";
import type { PromptDefinition } from "guidlio-lm";

const schemaMap: Record<string, z.ZodSchema<unknown>> = {
	"classify-ticket": z.object({
		category: z.string(),
		priority: z.enum(["low", "medium", "high"]),
	}),
};

// Module-level registry — replaced atomically by the reload loop
let activeRegistry: PromptRegistry = new PromptRegistry();

export function getRegistry(): PromptRegistry {
	return activeRegistry;
}

async function fetchAndBuildRegistry(): Promise<PromptRegistry> {
	const response = await fetch(`${process.env.PROMPTS_API_URL}/prompts`);
	if (!response.ok) throw new Error(`Prompt reload failed: HTTP ${response.status}`);

	const definitions = (await response.json()) as Array<
		Omit<PromptDefinition, "output"> & { output: { type: string } }
	>;

	const registry = new PromptRegistry();

	for (const def of definitions) {
		registry.register({
			...def,
			output: {
				type: def.output.type as "text" | "json",
				schema: schemaMap[def.promptId],
			},
		} as PromptDefinition);
	}

	return registry;
}

// Perform the initial load before the service starts accepting requests
activeRegistry = await fetchAndBuildRegistry();

// Reload every 5 minutes in the background.
// The assignment is atomic from JavaScript's single-threaded perspective —
// no partial state is ever visible to concurrent requests.
const RELOAD_INTERVAL_MS = 5 * 60 * 1000;
const reloadTimer = setInterval(async () => {
	try {
		const fresh = await fetchAndBuildRegistry();
		activeRegistry = fresh;
	} catch (err) {
		// Log and keep the last known good registry rather than clearing it
		console.error("Prompt reload failed — keeping previous registry", err);
	}
}, RELOAD_INTERVAL_MS);

// Prevent the timer from keeping the process alive after shutdown
if (typeof reloadTimer === "object" && "unref" in reloadTimer) {
	(reloadTimer as { unref(): void }).unref();
}
```

Because `GuidlioLMService` is constructed once with a fixed `promptRegistry` reference, pass the getter's return value per-request rather than at construction time. One way to do this is via a thin wrapper function:

```typescript
// service.ts
import { GuidlioLMService, OpenAIProvider } from "guidlio-lm";
import { getRegistry } from "./promptLoader";

// The service itself holds no registry reference — it receives one each call
function makeLlmService() {
	return new GuidlioLMService({
		providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
		promptRegistry: getRegistry(), // called at construction time
	});
}

// Re-create the service on each hot-reload cycle, or use a proxy pattern:
export function getLlmService(): GuidlioLMService {
	// For simplicity, construct fresh on each call — GuidlioLMService is cheap to construct
	return makeLlmService();
}
```

Or, pass a registry proxy that delegates to `getRegistry()` on every operation:

```typescript
import type { PromptDefinition, PromptRegistry as IPromptRegistry } from "guidlio-lm";
import { PromptRegistry } from "guidlio-lm";
import { getRegistry } from "./promptLoader";

// A thin proxy that forwards all calls to the current active registry
class RegistryProxy extends PromptRegistry {
	register(def: PromptDefinition): void {
		getRegistry().register(def);
	}
	getPrompt(promptId: string, version?: string | number): PromptDefinition | undefined {
		return getRegistry().getPrompt(promptId, version);
	}
	getAllPrompts(): PromptDefinition[] {
		return getRegistry().getAllPrompts();
	}
	clear(): void {
		getRegistry().clear();
	}
}

// Construct once — every LLM call transparently uses the latest loaded registry
const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: new RegistryProxy(),
});
```

## What to change next

- For static registries and variable interpolation details — see [05-prompt-registry.md](../05-prompt-registry.md).
- Combine loaded prompts with caching so hot-reloaded prompt versions bust the cache automatically — see [06-caching.md](../06-caching.md).
