import { z } from "zod";
import { LLMParseError, LLMSchemaError } from "../errors";

/**
 * Parse raw text as JSON; attempt a repair pass on failure.
 * Throws `LLMParseError` when both the initial parse and the repair fail.
 */
export function parseAndRepairJSON<T>(
	text: string,
	providerName: string,
	model: string,
	promptId: string,
	requestId?: string,
): T {
	try {
		return parseJSON<T>(text);
	} catch (parseError) {
		try {
			return JSON.parse(repairJSON(text)) as T;
		} catch (repairError) {
			throw new LLMParseError(
				`Failed to parse JSON response: ${
					repairError instanceof Error
						? repairError.message
						: String(repairError)
				}`,
				providerName,
				model,
				text,
				promptId,
				requestId,
				parseError instanceof Error ? parseError : undefined,
			);
		}
	}
}

/**
 * Validate a parsed value against a Zod schema.
 * Returns the value unchanged when no schema is provided.
 */
export function validateSchema<T>(
	parsed: T,
	schema: z.ZodSchema<T> | undefined,
	providerName: string,
	model: string,
	promptId: string,
	requestId?: string,
): T {
	if (!schema) return parsed;

	try {
		return schema.parse(parsed);
	} catch (validationError) {
		if (validationError instanceof z.ZodError) {
			throw new LLMSchemaError(
				`Schema validation failed: ${validationError.message}`,
				providerName,
				model,
				validationError.errors.map(
					(e) => `${e.path.join(".")}: ${e.message}`,
				),
				promptId,
				requestId,
				validationError,
			);
		}
		throw validationError;
	}
}

/**
 * Append a JSON-only instruction to the last user message if not already present.
 * Mutates the messages array in place.
 */
export function enforceJsonInstruction<
	M extends { role: string; content: string },
>(messages: M[]): void {
	if (messages.length === 0) return;

	const last = messages[messages.length - 1];
	if (last.role !== "user") return;

	const alreadyInstructed =
		last.content.includes("ONLY JSON") ||
		last.content.includes("valid JSON") ||
		last.content.includes("JSON format");

	if (!alreadyInstructed) {
		messages[messages.length - 1] = {
			...last,
			content: `${last.content}\n\nIMPORTANT: Return ONLY valid JSON. No markdown, no code fences, no explanatory text.`,
		};
	}
}

/**
 * Parse JSON with a descriptive error message.
 */
function parseJSON<T>(text: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(
			`JSON parse error: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * Repair JSON by stripping markdown fences and extracting the outermost
 * object or array block.
 */
function repairJSON(text: string): string {
	let repaired = text.trim();
	repaired = repaired.replace(/^```(?:json|JSON)?\s*/i, "");
	repaired = repaired.replace(/\s*```\s*$/, "");

	const firstObj = repaired.indexOf("{");
	const firstArr = repaired.indexOf("[");
	const first =
		firstObj === -1
			? firstArr
			: firstArr === -1
				? firstObj
				: Math.min(firstObj, firstArr);

	if (first === -1) return repaired.trim();

	const openChar = repaired[first];
	const closeChar = openChar === "{" ? "}" : "]";
	const last = repaired.lastIndexOf(closeChar);

	if (last > first) {
		repaired = repaired.substring(first, last + 1);
	}

	return repaired.trim();
}
