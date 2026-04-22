import type { LLMProvider } from "../providers/types";
import type { LLMServiceConfig } from "../types";
import type { LLMLogger } from "../../logger/types";

/**
 * Resolve a provider for a given model.
 *
 * 1. If `config.defaultProvider` resolves, use it.
 * 2. Otherwise pick the first registered provider whose `supportsModel` matches.
 * 3. With `strictProviderSelection` enabled, throw if nothing matches.
 * 4. Otherwise warn and fall back to the first registered provider.
 *
 * Misconfiguration warnings go to `logger.warn`, not `llmCall`, so they don't
 * inflate failed-call metrics.
 */
export function selectProvider(
	providers: Map<string, LLMProvider>,
	model: string,
	config: LLMServiceConfig,
	logger: LLMLogger | null,
): LLMProvider {
	if (config.defaultProvider) {
		const provider = providers.get(config.defaultProvider);
		if (provider) return provider;

		logger?.warn(
			`Default provider "${config.defaultProvider}" not found — falling back to auto-select`,
			{ model },
		);
	}

	for (const provider of providers.values()) {
		if (provider.supportsModel(model)) return provider;
	}

	if (config.strictProviderSelection) {
		throw new Error(`No registered provider supports model "${model}"`);
	}

	const firstProvider = Array.from(providers.values())[0];
	if (!firstProvider) {
		throw new Error("No LLM providers available");
	}

	logger?.warn(
		`No provider claimed model "${model}" — falling back to first registered provider "${firstProvider.name}"`,
		{ model },
	);

	return firstProvider;
}
