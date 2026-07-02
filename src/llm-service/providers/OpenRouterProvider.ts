import { OpenRouter } from "@openrouter/sdk";
import { LLMError } from "../errors";
import type {
	LLMProviderRequest,
	LLMProviderResponse,
	LLMProviderImageRequest,
	LLMProviderImageResponse,
	LLMProviderStreamResponse,
	LLMImageProvider,
	LLMStreamingProvider,
	LLMTextProvider,
} from "./types";
import type { ChatResult } from "@openrouter/sdk/models";
import { BaseLLMProvider, type ProviderImageUrlAttachment } from "./base";

interface OpenRouterErrorLike {
	name: string;
	message: string;
	statusCode?: number;
}

function isOpenRouterError(e: unknown): e is OpenRouterErrorLike {
	return (
		typeof e === "object" &&
		e !== null &&
		"message" in e &&
		typeof (e as { message: unknown }).message === "string" &&
		(("name" in e && (e as { name: unknown }).name === "OpenRouterError") ||
			("statusCode" in e && typeof (e as { statusCode: unknown }).statusCode === "number"))
	);
}

/**
 * OpenRouter provider adapter
 */
export class OpenRouterProvider
	extends BaseLLMProvider
	implements LLMTextProvider, LLMStreamingProvider, LLMImageProvider
{
	readonly name = "openrouter";

	/**
	 * OpenRouter model prefixes that this provider supports
	 */
	protected readonly supportedModelPrefixes = [
		"anthropic/",
		"google/",
		"meta-llama/",
		"mistralai/",
		"openai/",
		"deepseek/",
		"cohere/",
		"qwen/",
		"x-ai/",
		"microsoft/",
		"amazon/",
		"perplexity/",
		"nvidia/",
		"01-ai/",
		"black-forest-labs/",
		"bytedance-seed/",
		"recraft/",
		"sourceful/",
		"openrouter/",
	];

	private client: OpenRouter | null = null;

	constructor(private apiKey: string) {
		super();
	}

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
		messages: LLMProviderRequest["messages"],
	): Parameters<OpenRouter["chat"]["send"]>[0]["chatRequest"]["messages"] {
		return messages.map((msg) => {
			return {
				role: msg.role,
				content: msg.content,
			};
		}) as Parameters<OpenRouter["chat"]["send"]>[0]["chatRequest"]["messages"];
	}

	/**
	 * Call OpenRouter API with streaming response
	 */
	async callStream(request: LLMProviderRequest): Promise<LLMProviderStreamResponse> {
		try {
			const client = this.getClient();

			const chatParams: Parameters<typeof client.chat.send>[0] = {
				chatRequest: {
					model: request.model,
					messages: this.normalizeMessages(request.messages),
					temperature: request.temperature,
					maxTokens: request.maxTokens,
					topP: request.topP,
					seed: request.seed,
					stream: true,
				},
			};

			if (request.responseFormat === "json") {
				chatParams.chatRequest.responseFormat = {
					type: "json_object",
				};
			}

			const stream = await client.chat.send(chatParams, {
				signal: request.signal,
			});

			return {
				stream: this.streamTextDeltas(
					stream as AsyncIterable<{ choices: Array<{ delta?: { content?: string } }> }>,
					(part) => part.choices[0]?.delta?.content || "",
					(error) => this.wrapError(error, request.model),
				),
			};
		} catch (error) {
			throw this.wrapError(error, request.model);
		}
	}

	private wrapError(error: unknown, model: string): Error {
		if (isOpenRouterError(error)) {
			const statusCode = error.statusCode ?? 500;
			const isTransient =
				statusCode === 429 ||
				statusCode === 408 ||
				statusCode === 502 ||
				statusCode === 503 ||
				statusCode >= 500;
			const cause = new Error(error.message);
			const message = `OpenRouter API error: ${error.message}`;
			return isTransient
				? this.transientError(message, model, statusCode, cause)
				: this.permanentError(message, model, statusCode, cause);
		}

		if (error instanceof LLMError) return error;

		return this.unknownError(error, model);
	}

	/**
	 * Generate images through OpenRouter's dedicated Images API.
	 */
	async generateImage(request: LLMProviderImageRequest): Promise<LLMProviderImageResponse> {
		try {
			this.validateImageRequest(request);
			const client = this.getClient();

			const response = await client.images.generate(
				{
					imageGenerationRequest: {
						model: request.model,
						prompt: request.prompt,
						stream: false,
						...(request.numberOfImages !== undefined ? { n: request.numberOfImages } : {}),
						...(request.imageSize ? { resolution: this.toResolution(request.imageSize) } : {}),
						...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
						...(request.outputMimeType
							? { outputFormat: this.toOutputFormat(request.outputMimeType) }
							: {}),
						...(request.outputCompressionQuality !== undefined
							? { outputCompression: request.outputCompressionQuality }
							: {}),
						...(request.seed !== undefined ? { seed: request.seed } : {}),
						...(request.inputImages?.length
							? {
									inputReferences: request.inputImages.map((image) => ({
										type: "image_url" as const,
										imageUrl: {
											url: `data:${image.mimeType};base64,${this.stripDataUrlPrefix(image.data)}`,
										},
									})),
								}
							: {}),
					},
				},
				{ signal: request.signal },
			);

			const images = response.data
				.filter((image) => Boolean(image.b64Json))
				.map((image) => ({
					data: image.b64Json,
					mimeType: image.mediaType ?? request.outputMimeType ?? "image/png",
				}));

			if (images.length === 0) {
				throw new LLMError({
					message: "No images returned from OpenRouter",
					provider: this.name,
					model: request.model,
				});
			}

			return { images, raw: response };
		} catch (error) {
			throw this.wrapError(error, request.model);
		}
	}

	supportsImageGeneration(model: string): boolean {
		return this.supportsModel(model);
	}

	private validateImageRequest(request: LLMProviderImageRequest): void {
		if (!request.prompt.trim()) {
			throw this.permanentError(
				"OpenRouter image generation requires a non-empty prompt.",
				request.model,
			);
		}
		if (
			request.numberOfImages !== undefined &&
			(request.numberOfImages < 1 || request.numberOfImages > 10)
		) {
			throw this.permanentError(
				"OpenRouter numberOfImages must be between 1 and 10.",
				request.model,
			);
		}
		if (
			request.outputCompressionQuality !== undefined &&
			(request.outputCompressionQuality < 0 || request.outputCompressionQuality > 100)
		) {
			throw this.permanentError(
				"OpenRouter outputCompressionQuality must be between 0 and 100.",
				request.model,
			);
		}
	}

	private toResolution(
		imageSize: NonNullable<LLMProviderImageRequest["imageSize"]>,
	): "512" | "1K" | "2K" | "4K" {
		return imageSize === "0.5K" ? "512" : imageSize;
	}

	private toOutputFormat(outputMimeType: NonNullable<LLMProviderImageRequest["outputMimeType"]>) {
		return outputMimeType === "image/jpeg" ? "jpeg" : "png";
	}

	private stripDataUrlPrefix(data: string): string {
		return data.startsWith("data:") ? (data.split(",")[1] ?? data) : data;
	}

	/**
	 * Call OpenRouter API with normalized request
	 */
	async call(request: LLMProviderRequest): Promise<LLMProviderResponse> {
		try {
			const client = this.getClient();

			const chatParams: Parameters<typeof client.chat.send>[0] = {
				chatRequest: {
					model: request.model,
					messages: this.normalizeMessages(request.messages),
					temperature: request.temperature,
					maxTokens: request.maxTokens,
					topP: request.topP,
					seed: request.seed,
					stream: false,
				},
			};

			if (request.responseFormat === "json") {
				chatParams.chatRequest.responseFormat = {
					type: "json_object",
				};
			}

			const completion = (await client.chat.send(chatParams, {
				signal: request.signal,
			})) as ChatResult;

			const choice = completion.choices[0];
			const message = choice?.message;

			const content = typeof message?.content === "string" ? message.content : null;

			if (!content) {
				throw new LLMError({
					message: "No response content from OpenRouter",
					provider: this.name,
					model: request.model,
					requestId: completion.id,
				});
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

	override supportsAttachments(attachments: ProviderImageUrlAttachment[], model: string): boolean {
		return this.supportsImageUrlAttachments(attachments, model);
	}
}
