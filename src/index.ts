/**
 * LLM Gateway - Professional NPM Package Public API
 */

// Core Service & Providers
export { LLMService } from "./llm-service";
export { OpenAIProvider } from "./llm-service";
export { OpenRouterProvider } from "./llm-service";
export { GeminiProvider } from "./llm-service";

// Registry & Cache
export { PromptRegistry } from "./llm-service";
export { InMemoryCacheProvider } from "./llm-service";

// Pipeline Framework (Orchestrator)
export {
	PipelineOrchestrator,
	PipelineStep,
	DefaultPolicy,
	LoggerPipelineObserver,
	STEP_STATUS,
	PIPELINE_STATUS,
	OUTCOME_TYPE,
	TRANSITION_TYPE,
	ok,
	failed,
	redirect,
	PipelineError,
	PipelineDefinitionError,
	StepExecutionError,
} from "./orchestrator";

export type {
	PipelineRunResult,
	PipelineOrchestratorConfig,
	PipelineRunOptions,
	BaseContext,
	StepResult,
	StepOutcome,
	PipelineObserver,
} from "./orchestrator";

// Global Types
export type {
	LLMTextParams,
	LLMJsonParams,
	LLMTextResult,
	LLMJsonResult,
	LLMStreamResult,
	LLMEmbedParams,
	LLMEmbedResult,
	LLMEmbedBatchParams,
	LLMEmbedBatchResult,
	LLMServiceConfig,
	CacheConfig,
	LLMLogger,
} from "./types";

export type {
	PromptDefinition,
	PromptOutputConfig,
	PromptModelDefaults,
} from "./llm-service";

// Errors
export {
	LLMError,
	LLMTransientError,
	LLMPermanentError,
	LLMParseError,
	LLMSchemaError,
} from "./errors";

// Logger
export { ConsoleLogger } from "./logger/logger";
