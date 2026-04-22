import { OpenRouter } from '@openrouter/sdk';
import { LLMError, LLMTransientError, LLMPermanentError } from '../errors';
import type {
  LLMProvider,
  LLMProviderRequest,
  LLMProviderResponse,
  LLMProviderStreamResponse,
  LLMProviderEmbedRequest,
  LLMProviderEmbedResponse,
  LLMProviderEmbedBatchRequest,
  LLMProviderEmbedBatchResponse,
} from './types';
import type { ChatResponse } from '@openrouter/sdk/models';

/**
 * OpenRouter provider adapter
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';

  /**
   * OpenRouter model prefixes that this provider supports
   */
  private readonly supportedModelPrefixes = [
    'anthropic/', // Claude models
    'google/', // Gemini models
    'meta-llama/', // Llama models
    'mistralai/', // Mistral models
    'openai/', // OpenAI via OpenRouter
    'deepseek/', // DeepSeek models
    'cohere/', // Cohere models
    'qwen/', // Qwen models
  ];

  private client: OpenRouter | null = null;

  constructor(private apiKey: string) {}

  private getClient(): OpenRouter {
    if (!this.client) {
      this.client = new OpenRouter({
        apiKey: this.apiKey,
      });
    }
    return this.client;
  }

  /**
   * Convert normalized request to OpenRouter message format
   */
  private normalizeMessages(
    messages: LLMProviderRequest['messages']
  ): Array<
    | { role: 'system'; content: string }
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string }
    | { role: 'developer'; content: string }
  > {
    return messages.map((msg) => {
      return {
        role: msg.role,
        content: msg.content,
      };
    });
  }

  /**
   * Call OpenRouter API with streaming response
   */
  async callStream(
    request: LLMProviderRequest
  ): Promise<LLMProviderStreamResponse> {
    try {
      const client = this.getClient();

      const chatParams: Parameters<typeof client.chat.send>[0] = {
        chatGenerationParams: {
          model: request.model,
          messages: this.normalizeMessages(request.messages),
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          topP: request.topP,
          seed: request.seed,
          stream: true,
        },
      };

      if (request.responseFormat === 'json') {
        chatParams.chatGenerationParams.responseFormat = {
          type: 'json_object',
        };
      }

      const stream = await client.chat.send(chatParams);

      return {
        stream: (async function* () {
          let fullText = '';
          const asyncStream = stream as AsyncIterable<{
            choices: Array<{ delta?: { content?: string } }>;
          }>;
          for await (const part of asyncStream) {
            const delta = part.choices[0]?.delta?.content || '';
            fullText += delta;
            yield { text: fullText, delta };
          }
        })(),
      };
    } catch (error) {
      throw this.wrapError(error, request.model);
    }
  }

  private wrapError(error: unknown, model: string): Error {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'OpenRouterError') {
      const err = error as any;
      const statusCode = err.statusCode || 500;
      const isTransient =
        statusCode === 429 ||
        statusCode === 408 ||
        statusCode === 502 ||
        statusCode === 503 ||
        statusCode >= 500;

      if (isTransient) {
        return new LLMTransientError(
          `OpenRouter API error: ${err.message}`,
          'openrouter',
          model,
          undefined,
          undefined,
          statusCode,
          err
        );
      } else {
        return new LLMPermanentError(
          `OpenRouter API error: ${err.message}`,
          'openrouter',
          model,
          undefined,
          undefined,
          statusCode,
          err
        );
      }
    }

    if (error instanceof LLMError) {
      return error;
    }

    return new LLMError(
      error instanceof Error ? error.message : 'Unknown error',
      'openrouter',
      model,
      undefined,
      undefined,
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  }

  /**
   * Call OpenRouter API with normalized request
   */
  async call(request: LLMProviderRequest): Promise<LLMProviderResponse> {
    try {
      const client = this.getClient();

      const chatParams: Parameters<typeof client.chat.send>[0] = {
        chatGenerationParams: {
          model: request.model,
          messages: this.normalizeMessages(request.messages),
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          topP: request.topP,
          seed: request.seed,
          stream: false,
        },
      };

      if (request.responseFormat === 'json') {
        chatParams.chatGenerationParams.responseFormat = {
          type: 'json_object',
        };
      }

      const completion = (await client.chat.send(chatParams)) as ChatResponse;

      const choice = completion.choices[0];
      const message = choice?.message;

      const content =
        typeof message?.content === 'string' ? message.content : null;

      if (!content) {
        throw new LLMError(
          'No response content from OpenRouter',
          'openrouter',
          request.model,
          undefined,
          completion.id
        );
      }

      return {
        text: content,
        raw: completion,
        usage: completion.usage
          ? {
              promptTokens: completion.usage.promptTokens,
              completionTokens: completion.usage.completionTokens,
              totalTokens: completion.usage.totalTokens,
            }
          : undefined,
        finishReason: choice?.finishReason ?? undefined,
        requestId: completion.id,
      };
    } catch (error) {
      throw this.wrapError(error, request.model);
    }
  }

  /**
   * Generate vector embedding for text (not supported)
   */
  async embed(
    _request: LLMProviderEmbedRequest
  ): Promise<LLMProviderEmbedResponse> {
    throw new Error('Embeddings are not supported by OpenRouter provider');
  }

  /**
   * Generate vector embeddings for multiple texts (not supported)
   */
  async embedBatch(
    _request: LLMProviderEmbedBatchRequest
  ): Promise<LLMProviderEmbedBatchResponse> {
    throw new Error('Embeddings are not supported by OpenRouter provider');
  }

  /**
   * Check if this provider supports a given model
   */
  supportsModel(model: string): boolean {
    return this.supportedModelPrefixes.some((prefix) =>
      model.toLowerCase().startsWith(prefix)
    );
  }
}
