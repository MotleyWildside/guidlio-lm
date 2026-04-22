/**
 * Normalized request format for LLM providers
 */
export interface LLMMessage {
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string;
}

export interface LLMProviderRequest {
  messages: LLMMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  responseFormat?: 'text' | 'json';
  seed?: number;
  signal?: AbortSignal;
}

/**
 * Normalized response format from LLM providers
 */
export interface LLMProviderResponse {
  text: string;
  raw: unknown;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
  requestId?: string;
}

/**
 * Normalized stream response format
 */
export interface LLMProviderStreamResponse {
  stream: AsyncIterable<{
    text: string;
    delta: string;
  }>;
  requestId?: string;
}

/**
 * Normalized embedding request
 */
export interface LLMProviderEmbedRequest {
  text: string;
  model: string;
  dimensions?: number;
  taskType?: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
  signal?: AbortSignal;
}

/**
 * Normalized batch embedding request
 */
export interface LLMProviderEmbedBatchRequest {
  texts: string[];
  model: string;
  dimensions?: number;
  taskType?: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
  signal?: AbortSignal;
}

/**
 * Normalized embedding response
 */
export interface LLMProviderEmbedResponse {
  embedding: number[];
  usage?: {
    totalTokens: number;
  };
}

/**
 * Normalized batch embedding response
 */
export interface LLMProviderEmbedBatchResponse {
  embeddings: number[][];
  usage?: {
    totalTokens: number;
  };
}

/**
 * Base interface for all LLM providers
 */
export interface LLMProvider {
  /**
   * Provider identifier (e.g., 'openai', 'anthropic', 'google')
   */
  readonly name: string;

  /**
   * Call the provider with a normalized request
   */
  call(request: LLMProviderRequest): Promise<LLMProviderResponse>;

  /**
   * Call the provider with a streaming response
   */
  callStream(request: LLMProviderRequest): Promise<LLMProviderStreamResponse>;

  /**
   * Generate vector embedding for text
   */
  embed(request: LLMProviderEmbedRequest): Promise<LLMProviderEmbedResponse>;

  /**
   * Generate vector embeddings for multiple texts
   */
  embedBatch(
    request: LLMProviderEmbedBatchRequest
  ): Promise<LLMProviderEmbedBatchResponse>;

  /**
   * Check if this provider supports a given model
   */
  supportsModel(model: string): boolean;
}
