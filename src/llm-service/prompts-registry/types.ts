import { z } from 'zod';

/**
 * Output configuration for a prompt
 */
export interface PromptOutputConfig {
  type: 'text' | 'json';
  schema?: z.ZodSchema;
}

/**
 * Model defaults for a prompt
 */
export interface PromptModelDefaults {
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

/**
 * Prompt definition stored in the registry
 */
export interface PromptDefinition {
  promptId: string;
  version: string | number;
  systemPrompt?: string;
  developer?: string;
  userPrompt?: string;
  modelDefaults: PromptModelDefaults;
  output: PromptOutputConfig;
}


/**
 * Type for valid prompt IDs
 */
export type PromptId = string;

/**
 * Type for flow names
 */
export type FlowName = string;

/**
 * Type for step names within a flow
 */
export type StepName = string;
