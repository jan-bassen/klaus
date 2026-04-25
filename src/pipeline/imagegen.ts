/**
 * Image generation against the same OpenAI-compatible /chat/completions
 * endpoint as the agent loop. Uses `modalities: ["image", "text"]` and reads
 * the resulting bytes from `choices[0].message.images[0].imageUrl.url` (a
 * base64 data URL). One provider, one auth path.
 */

import { OpenRouter } from "@openrouter/sdk";
import { resolveProvider, settings } from "@/infra/config";
import { log } from "@/infra/logger";

export interface GeneratedImage {
	bytes: Buffer;
	mimeType: string;
}

export interface GenerateImageInput {
	prompt: string;
	/** Override the configured image model. */
	model?: string;
}

export async function generateImage(
	input: GenerateImageInput,
): Promise<GeneratedImage | Error> {
	const { config: providerCfg, apiKey } = resolveProvider();
	const model = input.model || settings.media.image.gen.model;

	if (!model) {
		return new Error(
			"No image generation model configured. Set media.image.gen.model in settings.yml.",
		);
	}

	log.info(`[imagegen] generating with ${model}`);

	const client = new OpenRouter({
		apiKey,
		serverURL: providerCfg.baseURL,
		retryConfig: { strategy: "none" },
	});

	try {
		const response = await client.chat.send({
			chatRequest: {
				model,
				modalities: ["image", "text"],
				messages: [{ role: "user", content: input.prompt }],
				stream: false,
			},
		});

		const message = response.choices[0]?.message;
		const dataUrl = message?.images?.[0]?.imageUrl?.url;
		if (!dataUrl) {
			return new Error(
				`Image model ${model} returned no image data. Check that the model supports image output.`,
			);
		}

		return decodeDataUrl(dataUrl);
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}

function decodeDataUrl(dataUrl: string): GeneratedImage | Error {
	const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) {
		return new Error("Image response was not a base64 data URL");
	}
	const mimeType = match[1] ?? "image/png";
	const base64 = match[2] ?? "";
	return { bytes: Buffer.from(base64, "base64"), mimeType };
}
