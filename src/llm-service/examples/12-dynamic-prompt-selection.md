# Dynamic Prompt Selection

The prompt registry is a versioned store that lets you pin calls to a specific prompt version for reproducibility, use "latest" for rapid iteration, and register new versions at runtime for hot-swap or A/B testing — all without restarting the service.

**Concepts covered:**
- `promptVersion: "latest"` vs pinning to a specific version
- A/B testing via user cohort routing
- Hot-swapping: registering a new version at runtime
- Blue/green promotion pattern
- Caveat: re-registering the same version silently replaces it

---

## "latest" vs pinned versions

Omitting `promptVersion` (or passing `"latest"`) resolves to the highest-registered version for that `promptId`. The resolution is purely numeric first, then lexicographic — so version `10` beats version `9`, and version `"beta"` sorts lexicographically among non-numeric versions.

```typescript
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";

const registry = new PromptRegistry();

registry.register({
	promptId: "summarize",
	version: 1,
	userPrompt: "Summarize this article in 3 sentences: {text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.3 },
	output: { type: "text" },
});

registry.register({
	promptId: "summarize",
	version: 2,
	// Improved prompt — more specific length constraint
	userPrompt: "Summarize the following article in exactly 3 sentences, each under 25 words: {text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.2 },
	output: { type: "text" },
});

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});

// Resolves to version 2 — the highest registered
const latest = await llm.callText({
	promptId: "summarize",
	variables: { text: article },
	// promptVersion omitted → "latest"
});

// Pinned to version 1 — never changes even if version 3 is registered later
const pinned = await llm.callText({
	promptId: "summarize",
	variables: { text: article },
	promptVersion: 1,
});
```

**When to use each:**
- `"latest"` (or omit): safe during development and in services where the registry is only populated at startup and never changes after that
- Pinned version: use in production when reproducibility matters — the response must be identical across deployments regardless of what else is registered

---

## A/B testing via cohort routing

Register two prompt versions and route each user request to one based on a deterministic cohort assignment. Both versions are always available; no redeployment is needed to shift traffic.

```typescript
function getPromptVersion(userId: string): 1 | 2 {
	// Simple deterministic hash — same user always goes to the same variant
	const hash = userId.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
	return hash % 2 === 0 ? 1 : 2;
}

async function summarizeForUser(userId: string, text: string): Promise<string> {
	const version = getPromptVersion(userId);

	const result = await llm.callText({
		promptId: "summarize",
		variables: { text },
		promptVersion: version,
		// Include variant in traceId for downstream attribution
		traceId: `user:${userId}:v${version}`,
	});

	return result.text;
}
```

Log `result.promptVersion` from the result to measure outcomes per variant. The version is always included in the result regardless of whether you pinned it or used "latest".

---

## Hot-swapping with runtime registration

`registry.register()` adds a new version immediately. Any subsequent call that resolves "latest" picks it up — there is no service restart, no deployment.

```typescript
// At startup: only version 1 exists
registry.register({
	promptId: "classify",
	version: 1,
	userPrompt: "Classify this text as positive, neutral, or negative: {text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0 },
	output: { type: "text" },
});

// --- later, during a live deploy or flag change ---

// Register an improved version
registry.register({
	promptId: "classify",
	version: 2,
	userPrompt: "Classify the sentiment of the following text. Reply with exactly one word: positive, neutral, or negative.\n\n{text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0 },
	output: { type: "text" },
});

// All new requests using promptVersion: "latest" now use version 2
// Requests pinned to promptVersion: 1 are unaffected
```

---

## Blue/green promotion pattern

Combine a feature flag with explicit version numbers to control when new traffic switches to the updated prompt. Set a flag, register the new version, then flip the flag — rollback is just flipping the flag back.

```typescript
let activePromptVersion: 1 | 2 | 3 = 1;

// When a flag change is detected (polling, webhook, etc.)
async function promoteToVersion3(): Promise<void> {
	// Register the new version first — existing traffic is unaffected
	registry.register({
		promptId: "summarize",
		version: 3,
		userPrompt: "Write a concise 2-sentence summary of: {text}",
		modelDefaults: { model: "gpt-4o", temperature: 0.2 },
		output: { type: "text" },
	});

	// Atomically flip the active version — all new requests use v3
	activePromptVersion = 3;
}

// Each request reads the current active version
async function handleRequest(text: string): Promise<string> {
	const result = await llm.callText({
		promptId: "summarize",
		variables: { text },
		promptVersion: activePromptVersion,
	});
	return result.text;
}
```

Rollback: set `activePromptVersion = 1` to instantly route all traffic back to the stable version. No version is ever deleted from the registry — old versions remain accessible.

---

## Caveat: re-registering the same version

Calling `registry.register()` with a `promptId` and `version` that already exists **silently replaces** the existing entry. Last write wins. This is intentional for development but can cause surprises in production if two code paths both register the same version with different content.

```typescript
registry.register({ promptId: "greet", version: 1, userPrompt: "Say hello to {name}.", modelDefaults: { model: "gpt-4o-mini" }, output: { type: "text" } });

// This silently overwrites the entry above — no error, no warning
registry.register({ promptId: "greet", version: 1, userPrompt: "Say goodbye to {name}.", modelDefaults: { model: "gpt-4o-mini" }, output: { type: "text" } });

// Calls now use "Say goodbye to {name}." — probably not intended
```

To prevent this, always increment the version number when changing a prompt, or validate your registry setup in tests.

---

## What to change next

- [05-prompt-registry.md](./05-prompt-registry.md) — full prompt registry reference including `buildMessages` and variable interpolation
- [09-idempotency-and-cache-keys.md](./09-idempotency-and-cache-keys.md) — cache keys include `promptVersion`, so pinned and "latest" calls produce separate cache entries
