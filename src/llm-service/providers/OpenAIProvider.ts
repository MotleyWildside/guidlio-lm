import OpenAI from 'openai';
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

/**
 * OpenAI provider adapter
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';

  /**
   * OpenAI model prefixes that this provider supports
   */
  private readonly supportedModelPrefixes = [
    'gpt-',
    'o1-',
    'o3-',
    'text-embedding-3-',
  ];

  private client: OpenAI | null = null;

  constructor(private apiKey: string) {}

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: this.apiKey,
      });
    }
    return this.client;
  }

  /**
   * Convert normalized request to OpenAI format
   */
  private normalizeMessages(
    messages: LLMProviderRequest['messages']
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      // OpenAI doesn't support 'developer' role, map it to 'system'
      if (msg.role === 'developer') {
        return { role: 'system', content: msg.content };
      }
      return {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      };
    });
  }

  /**
   * Call OpenAI API with streaming response
   */
  async callStream(
    request: LLMProviderRequest
  ): Promise<LLMProviderStreamResponse> {
    try {
      const client = this.getClient();

      const openaiParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming =
        {
          model: request.model,
          messages: this.normalizeMessages(request.messages),
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          top_p: request.topP,
          seed: request.seed,
          stream: true,
        };

      if (request.responseFormat === 'json') {
        openaiParams.response_format = { type: 'json_object' };
      }

      const stream = await client.chat.completions.create(openaiParams, {
        signal: request.signal,
      });

      return {
        stream: (async function* () {
          let fullText = '';
          for await (const part of stream) {
            const delta = part.choices[0]?.delta?.content || '';
            fullText += delta;
            yield { text: fullText, delta };
          }
        })(),
      };
    } catch (error) {
      // Reuse error handling logic from call() if possible, or just wrap
      throw this.wrapError(error, request.model);
    }
  }

  private wrapError(error: unknown, model: string): Error {
    if (error instanceof OpenAI.APIError) {
      const statusCode = error.status || 500;
      const isTransient =
        statusCode === 429 ||
        statusCode >= 500 ||
        error.code === 'rate_limit_exceeded' ||
        error.code === 'server_error' ||
        error.code === 'timeout';

      if (isTransient) {
        return new LLMTransientError(
          `OpenAI API error: ${error.message}`,
          'openai',
          model,
          undefined,
          undefined,
          statusCode,
          error
        );
      } else {
        return new LLMPermanentError(
          `OpenAI API error: ${error.message}`,
          'openai',
          model,
          undefined,
          undefined,
          statusCode,
          error
        );
      }
    }

    if (error instanceof LLMError) {
      return error;
    }

    return new LLMError(
      error instanceof Error ? error.message : 'Unknown error',
      'openai',
      model,
      undefined,
      undefined,
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  }

  /**
   * Call OpenAI API with normalized request
   */
  async call(request: LLMProviderRequest): Promise<LLMProviderResponse> {
    try {
      const client = this.getClient();

      const openaiParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
        {
          model: request.model,
          messages: this.normalizeMessages(request.messages),
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          top_p: request.topP,
          seed: request.seed,
        };

      if (request.responseFormat === 'json') {
        openaiParams.response_format = { type: 'json_object' };
      }

      const completion = await client.chat.completions.create(openaiParams, {
        signal: request.signal,
      });

      const choice = completion.choices[0];
      const message = choice?.message;

      if (!message?.content) {
        throw new LLMError(
          'No response content from OpenAI',
          'openai',
          request.model,
          undefined,
          completion.id
        );
      }

      return {
        text: message.content,
        raw: completion,
        usage: completion.usage
          ? {
              promptTokens: completion.usage.prompt_tokens,
              completionTokens: completion.usage.completion_tokens,
              totalTokens: completion.usage.total_tokens,
            }
          : undefined,
        finishReason: choice?.finish_reason,
        requestId: completion.id,
      };
    } catch (error) {
      throw this.wrapError(error, request.model);
    }
  }

  /**
   * Generate vector embedding for text
   */
  async embed(
    request: LLMProviderEmbedRequest
  ): Promise<LLMProviderEmbedResponse> {
    try {
      const client = this.getClient();
      const response = await client.embeddings.create(
        {
          model: request.model,
          input: request.text,
          dimensions: request.dimensions ?? 1536,
        },
        { signal: request.signal }
      );

      return {
        embedding: response.data[0].embedding,
        usage: {
          totalTokens: response.usage.total_tokens,
        },
      };
    } catch (error) {
      throw this.wrapError(error, request.model);
    }
  }

  /**
   * Generate vector embeddings for multiple texts using batch input
   */
  async embedBatch(
    request: LLMProviderEmbedBatchRequest
  ): Promise<LLMProviderEmbedBatchResponse> {
    try {
      const client = this.getClient();
      const response = await client.embeddings.create(
        {
          model: request.model,
          input: request.texts,
          dimensions: request.dimensions ?? 1536,
        },
        { signal: request.signal }
      );

      return {
        embeddings: response.data.map((d) => d.embedding),
        usage: {
          totalTokens: response.usage.total_tokens,
        },
      };
    } catch (error) {
      throw this.wrapError(error, request.model);
    }
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
