# JSON Extraction

## Schema defined at registration

Attach a Zod schema to the prompt definition. The service validates every response against it and throws `LLMSchemaError` on a mismatch.

```typescript
import { z } from "zod";
import { LLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";

const SentimentSchema = z.object({
	sentiment: z.enum(["positive", "neutral", "negative"]),
	score: z.number().min(0).max(1),
	explanation: z.string(),
});

type Sentiment = z.infer<typeof SentimentSchema>;

const registry = new PromptRegistry();

registry.register({
	promptId: "sentiment",
	version: 1,
	systemPrompt: "You classify sentiment. Always reply with valid JSON.",
	userPrompt: 'Classify: "{text}"',
	modelDefaults: { model: "gpt-4o-mini", temperature: 0 },
	output: { type: "json", schema: SentimentSchema },
});

const llm = new LLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: registry,
});

const result = await llm.callJSON<Sentiment>({
	promptId: "sentiment",
	variables: { text: "This library is fantastic!" },
});

console.log(result.data.sentiment); // "positive"
console.log(result.data.score);     // 0.95
```

## Schema override per-call

Pass `jsonSchema` on a call to validate against a different (or stricter) shape than the one registered on the prompt. Useful when the same prompt is reused across contexts.

```typescript
const StrictSchema = SentimentSchema.extend({
	language: z.string(),
});

const result = await llm.callJSON({
	promptId: "sentiment",
	variables: { text: "Super!" },
	jsonSchema: StrictSchema,
});
// result.data.language is required; validation fails if the model omits it
```

## JSON array responses

The JSON repair pipeline handles arrays as well as objects.

```typescript
const TagSchema = z.array(z.string().min(1));

registry.register({
	promptId: "tag",
	version: 1,
	userPrompt: "Return a JSON array of up to 5 topic tags for: {text}",
	modelDefaults: { model: "gpt-4o-mini", temperature: 0.2 },
	output: { type: "json", schema: TagSchema },
});

const result = await llm.callJSON<string[]>({
	promptId: "tag",
	variables: { text: "Building an LLM gateway in TypeScript" },
});
// result.data → ["llm", "typescript", "api", "gateway", "node"]
```

## Error handling

```typescript
import { LLMParseError, LLMSchemaError } from "guidlio-lm";

try {
	const result = await llm.callJSON({ promptId: "sentiment", variables: { text } });
} catch (err) {
	if (err instanceof LLMParseError) {
		// Model returned prose that couldn't be parsed even after repair
		console.error("Raw output:", err.rawOutput);
	} else if (err instanceof LLMSchemaError) {
		// Parsed successfully but failed Zod validation
		console.error("Validation errors:", err.validationErrors);
	}
}
```

## How JSON repair works

When `JSON.parse` fails, the service attempts one repair pass before giving up:

1. Strips leading ` ```json ` / ` ``` ` markdown fences and trailing ` ``` `.
2. Extracts the first `{…}` or `[…]` block from the remaining text.
3. Attempts `JSON.parse` on the extracted substring.
4. Throws `LLMParseError` if step 3 also fails.

To avoid needing repair at all, set `responseFormat: "json"` — which the service does automatically for `callJSON` — and use a provider that supports native JSON mode (OpenAI, Gemini).
