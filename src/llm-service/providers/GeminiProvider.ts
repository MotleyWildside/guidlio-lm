import {
  GoogleGenerativeAI,
  Content,
  TaskType,
  EmbedContentRequest,
} from '@google/generative-ai';
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
  LLMMessage,
} from './types';

/**
 * Gemini provider adapter
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';

  /**
   * Gemini model prefixes that this provider supports
   */
  private readonly supportedModelPrefixes = ['gemini-', 'gemini-embedding-'];

  private genAI: GoogleGenerativeAI;

  constructor(private apiKey: string) {
    this.genAI = new GoogleGenerativeAI(this.apiKey);
  }

  /**
   * Convert normalized messages to Gemini format
   */
  private convertMessages(messages: LLMMessage[]): {
    systemInstruction?: string;
    contents: Content[];
  } {
    let systemInstruction = '';
    const contents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'system' || msg.role === 'developer') {
        systemInstruction += (systemInstruction ? '\n' : '') + msg.content;
      } else {
        contents.push({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: msg.content }],
        });
      }
    }

    return {
      systemInstruction: systemInstruction || undefined,
      contents,
    };
  }

  /**
   * Call Gemini API with normalized request
   */
  async call(request: LLMProviderRequest): Promise<LLMProviderResponse> {
    try {
      const { systemInstruction, contents } = this.convertMessages(
        request.messages
      );

      const model = this.genAI.getGenerativeModel({
        model: request.model,
        systemInstruction,
      });

      const generationConfig = {
        temperature: request.temperature,
        topP: request.topP,
        maxOutputTokens: request.maxTokens,
        responseMimeType:
          request.responseFormat === 'json' ? 'application/json' : 'text/plain',
      };

      // For standard call, we can use generateContent if there's only one "user" message and no history
      // or startChat for full history. Given LLMProviderRequest has full history, startChat is better.
      const chat = model.startChat({
        history: contents.slice(0, -1),
        generationConfig,
      });

      const lastMessage = contents[contents.length - 1];
      const result = await chat.sendMessage(lastMessage.parts);
      const response = await result.response;
      const text = response.text();

      return {
        text,
        raw: response,
        usage: response.usageMetadata
          ? {
              promptTokens: response.usageMetadata.promptTokenCount,
              completionTokens: response.usageMetadata.candidatesTokenCount,
              totalTokens: response.usageMetadata.totalTokenCount,
            }
          : undefined,
        finishReason: response.candidates?.[0]?.finishReason,
      };
    } catch (error) {
      throw this.wrapError(error, request.model);
    }
  }

  /**
   * Call Gemini API with streaming response
   */
  async callStream(
    request: LLMProviderRequest
  ): Promise<LLMProviderStreamResponse> {
    try {
      const { systemInstruction, contents } = this.convertMessages(
        request.messages
      );

      const model = this.genAI.getGenerativeModel({
        model: request.model,
        systemInstruction,
      });

      const generationConfig = {
        temperature: request.temperature,
        topP: request.topP,
        maxOutputTokens: request.maxTokens,
        responseMimeType:
          request.responseFormat === 'json' ? 'application/json' : 'text/plain',
      };

      const chat = model.startChat({
        history: contents.slice(0, -1),
        generationConfig,
      });

      const lastMessage = contents[contents.length - 1];
      const result = await chat.sendMessageStream(lastMessage.parts);

      return {
        stream: (async function* () {
          let fullText = '';
          for await (const chunk of result.stream) {
            const delta = chunk.text();
            fullText += delta;
            yield { text: fullText, delta };
          }
        })(),
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
      const modelName = request.model;
      const model = this.genAI.getGenerativeModel({ model: modelName });

      // Cast taskType to TaskType enum if it's a string that matches
      const taskType =
        request.taskType === 'RETRIEVAL_QUERY'
          ? TaskType.RETRIEVAL_QUERY
          : TaskType.RETRIEVAL_DOCUMENT;

      const result = await model.embedContent({
        content: { parts: [{ text: request.text }], role: 'user' },
        taskType,
        // outputDimensionality is not in the standard EmbedContentRequest type in some versions
        // but it is supported by the API for some models. Using cast for this specific field.
        ...(request.dimensions
          ? { outputDimensionality: request.dimensions }
          : {}),
      } as EmbedContentRequest & { outputDimensionality?: number });

      return {
        embedding: Array.from(result.embedding.values),
      };
    } catch (error) {
      throw this.wrapError(error, request.model);
    }
  }

  /**
   * Generate vector embeddings for multiple texts using batch API
   */
  async embedBatch(
    request: LLMProviderEmbedBatchRequest
  ): Promise<LLMProviderEmbedBatchResponse> {
    try {
      const modelName = request.model;
      const model = this.genAI.getGenerativeModel({ model: modelName });

      const taskType =
        request.taskType === 'RETRIEVAL_QUERY'
          ? TaskType.RETRIEVAL_QUERY
          : TaskType.RETRIEVAL_DOCUMENT;

      const result = await model.batchEmbedContents({
        requests: request.texts.map(
          (text) =>
            ({
              content: { parts: [{ text }], role: 'user' },
              taskType,
              ...(request.dimensions
                ? { outputDimensionality: request.dimensions }
                : {}),
            }) as EmbedContentRequest & {
              outputDimensionality?: number;
            }
        ),
      });

      return {
        embeddings: result.embeddings.map((e) => Array.from(e.values)),
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

  private wrapError(error: unknown, model: string): Error {
    // Gemini error handling
    if (error instanceof LLMError) return error;

    const message = error instanceof Error ? error.message : String(error);
    const originalError = error instanceof Error ? error : undefined;

    // Common Gemini errors
    if (
      message.includes('rate limit') ||
      message.includes('429') ||
      message.includes('overloaded')
    ) {
      return new LLMTransientError(
        `Gemini API transient error: ${message}`,
        'gemini',
        model,
        undefined,
        undefined,
        429,
        originalError
      );
    }

    if (
      message.includes('permission') ||
      message.includes('403') ||
      message.includes('API key')
    ) {
      return new LLMPermanentError(
        `Gemini API auth error: ${message}`,
        'gemini',
        model,
        undefined,
        undefined,
        403,
        originalError
      );
    }

    return new LLMError(
      `Gemini API error: ${message}`,
      'gemini',
      model,
      undefined,
      undefined,
      undefined,
      originalError || new Error(String(error))
    );
  }
}
