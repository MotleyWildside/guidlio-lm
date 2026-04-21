import type { PromptDefinition } from './types';

/**
 * Prompt Registry for managing versioned prompts with variable interpolation
 */
export class PromptRegistry {
  private prompts: Map<string, PromptDefinition> = new Map();

  /**
   * Register a prompt definition
   */
  register(prompt: PromptDefinition): void {
    const key = this.getKey(prompt.promptId, prompt.version);
    this.prompts.set(key, prompt);
  }

  /**
   * Get a prompt by ID and optional version (defaults to latest)
   */
  getPrompt(
    promptId: string,
    version?: string | number
  ): PromptDefinition | null {
    if (version !== undefined) {
      const key = this.getKey(promptId, version);
      return this.prompts.get(key) || null;
    }

    // Find latest version
    let latest: PromptDefinition | null = null;
    let latestVersion: string | number | null = null;

    for (const [, prompt] of this.prompts.entries()) {
      if (prompt.promptId === promptId) {
        const currentVersion =
          typeof prompt.version === 'string'
            ? parseFloat(prompt.version)
            : prompt.version;

        if (
          latestVersion === null ||
          (typeof latestVersion === 'number' &&
            typeof currentVersion === 'number' &&
            currentVersion > latestVersion)
        ) {
          latest = prompt;
          latestVersion = currentVersion;
        }
      }
    }

    return latest;
  }

  /**
   * Build messages array from prompt definition and variables
   */
  buildMessages(
    prompt: PromptDefinition,
    variables?: Record<string, unknown>
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }> = [];

    // Add system message if present
    if (prompt.system) {
      messages.push({
        role: 'system',
        content: this.interpolate(prompt.system, variables),
      });
    }

    // Add developer message if present (treated as system message)
    if (prompt.developer) {
      messages.push({
        role: 'system',
        content: this.interpolate(prompt.developer, variables),
      });
    }

    // Add user message if present
    if (prompt.userTemplate) {
      messages.push({
        role: 'user',
        content: this.interpolate(prompt.userTemplate, variables),
      });
    }

    return messages;
  }

  /**
   * Interpolate variables in template string
   * Supports {variableName} syntax
   */
  private interpolate(
    template: string,
    variables?: Record<string, unknown>
  ): string {
    if (!variables) {
      return template;
    }

    return template.replace(/\{(\w+)\}/g, (match, key) => {
      const value = variables[key];
      if (value === undefined) {
        return match; // Keep original if variable not found
      }
      // Convert to string, handling objects/arrays
      if (typeof value === 'object' && value !== null) {
        return JSON.stringify(value);
      }
      return String(value);
    });
  }

  /**
   * Generate a key for storing prompts
   */
  private getKey(promptId: string, version: string | number): string {
    return `${promptId}@${version}`;
  }

  /**
   * Get all registered prompts (for debugging/inspection)
   */
  getAllPrompts(): PromptDefinition[] {
    return Array.from(this.prompts.values());
  }

  /**
   * Clear all registered prompts (for testing)
   */
  clear(): void {
    this.prompts.clear();
  }
}
