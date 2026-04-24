import { z } from "zod";
import { createHash } from "crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { LLMTextParams, LLMJsonParams } from "../types";

/**
 * Build cache key from params + the resolved prompt and model.
 * Uses nullish checks so `0` is a distinct key, not "unset".
 * Hashes the resolved model (not `params.model`) so default-model changes
 * invalidate stale entries.
 */
export function buildCacheKey(
	params: LLMTextParams | LLMJsonParams,
	prompt: { promptId: string; version: string | number },
	resolvedModel: string,
): string {
	const hasSchema = (params as LLMJsonParams).jsonSchema !== undefined;
	const schemaFingerprint = fingerprintSchema((params as LLMJsonParams).jsonSchema);

	const keyParts = [
		params.idempotencyKey ?? "",
		prompt.promptId,
		String(prompt.version),
		JSON.stringify(params.variables ?? {}),
		resolvedModel,
		params.temperature != null ? String(params.temperature) : "",
		params.maxTokens != null ? String(params.maxTokens) : "",
		params.topP != null ? String(params.topP) : "",
		params.seed != null ? String(params.seed) : "",
		hasSchema ? "json" : "text",
		schemaFingerprint,
	];

	return createHash("sha256").update(keyParts.join("|")).digest("hex");
}

function fingerprintSchema(schema: z.ZodSchema | undefined): string {
	if (!schema) return "";
	try {
		const jsonSchema = zodToJsonSchema(schema);
		return createHash("sha256").update(JSON.stringify(jsonSchema)).digest("hex").slice(0, 16);
	} catch {
		return "schema";
	}
}
