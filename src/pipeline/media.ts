/**
 * All media-in/out for the pipeline lives here:
 *   STT, TTS, vision prep, document parse, image generation.
 *
 * Lower-level transport (downloading WhatsApp blobs, sending audio back) stays
 * in `infra/whatsapp`. This module is the single surface the pipeline talks to.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { LiteParse } from "@llamaindex/liteparse";
import { OpenRouter } from "@openrouter/sdk";
import sharp from "sharp";
import { resolveImageModel, settings } from "../infra/config.ts";
import { log } from "../infra/logger.ts";

import { readArrayBuffer, readText, writeData } from "../infra/runtime.ts";

// ── Speech-to-Text ─────────────────────────────────────────────────────────

const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";

/** Transcribe an audio file via ElevenLabs Scribe. Returns the transcript or an Error value. */
export async function transcribe(
	filePath: string,
	mimeType: string,
): Promise<string | Error> {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	if (!apiKey) return new Error("transcribe: ELEVENLABS_API_KEY not set");

	const fileName = path.basename(filePath);
	const form = new FormData();
	form.append("model_id", settings.media.voice.stt.model);
	form.append(
		"file",
		new Blob([await readArrayBuffer(filePath)], { type: mimeType }),
		fileName,
	);

	try {
		const res = await fetch(SCRIBE_URL, {
			method: "POST",
			headers: { "xi-api-key": apiKey },
			body: form,
			signal: AbortSignal.timeout(settings.media.voice.stt.timeout),
		});

		if (!res.ok) {
			const body = await res.text();
			log.warn(`[media] STT API error (${res.status})`, { body });
			return new Error(`STT error ${res.status}: ${body}`);
		}

		const json = (await res.json()) as { text?: string };
		return json.text ?? "";
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}

// ── Text-to-Speech ─────────────────────────────────────────────────────────

const TTS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";

/** Synthesise speech via ElevenLabs. Returns an MP3 buffer or an Error value. */
export async function textToSpeech(text: string): Promise<Buffer | Error> {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	if (!apiKey) return new Error("textToSpeech: ELEVENLABS_API_KEY not set");

	const voiceId = settings.media.voice.tts.voiceId;
	if (!voiceId) return new Error("textToSpeech: tts.voiceId is not set");

	try {
		const res = await fetch(`${TTS_BASE}/${voiceId}`, {
			method: "POST",
			headers: {
				"xi-api-key": apiKey,
				"Content-Type": "application/json",
				Accept: "audio/mpeg",
			},
			body: JSON.stringify({ text, model_id: settings.media.voice.tts.model }),
		});

		if (!res.ok) {
			const body = await res.text();
			log.warn(`[media] TTS API error (${res.status})`, { body });
			return new Error(`TTS error ${res.status}: ${body}`);
		}

		return Buffer.from(await res.arrayBuffer());
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}

// ── Vision prep ────────────────────────────────────────────────────────────

/**
 * Downscale an image to fit inside `vision.maxImageDimension` on its longest side
 * — keeps token cost bounded (Anthropic tiles at 512×512 ≈ 1500 tokens/tile).
 */
export async function prepareImage(filePath: string): Promise<Buffer> {
	const raw = await readArrayBuffer(filePath);
	const max = settings.media.image.vision.maxSize;
	return sharp(Buffer.from(raw))
		.resize(max, max, { fit: "inside", withoutEnlargement: true })
		.toBuffer();
}

// ── Document parse ─────────────────────────────────────────────────────────

const PARSEABLE_DOC_MIMES = new Set([
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/msword",
	"application/vnd.ms-excel",
	"application/vnd.ms-powerpoint",
]);

export function isParseableDocument(mimeType: string): boolean {
	return PARSEABLE_DOC_MIMES.has(mimeType);
}

let _parser: LiteParse | null = null;
function parser(): LiteParse {
	if (!_parser) {
		_parser = new LiteParse({
			ocrEnabled: settings.media.document.ocr,
			outputFormat: "text",
		});
	}
	return _parser;
}

/**
 * Parse a document to plain text. Caches in a `.parsed.txt` sidecar next to the
 * original blob so repeated reads (history rebuild, retry) avoid re-parsing.
 */
export async function parseDocument(
	filePath: string,
	mimeType: string,
): Promise<string | Error> {
	if (!isParseableDocument(mimeType)) {
		return new Error(`Unsupported mime type for parsing: ${mimeType}`);
	}

	const cachePath = `${filePath}.parsed.txt`;
	if (existsSync(cachePath)) {
		try {
			return await readText(cachePath);
		} catch (err) {
			log.warn("[media] sidecar read failed, reparsing", {
				cachePath,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	try {
		const result = await parser().parse(filePath);
		const text = trunc(result.text.trim(), settings.media.document.maxChars);
		await writeData(cachePath, text);
		return text;
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		log.warn("[media] document parse failed", {
			filePath,
			mimeType,
			error: error.message,
		});
		return error;
	}
}

// ── Image generation ──────────────────────────────────────────────────────

interface GeneratedImage {
	bytes: Buffer;
	mimeType: string;
}

interface GenerateImageInput {
	prompt: string;
	/** Optional input images to edit / use as visual context. */
	images?: Array<{ bytes: Buffer; mimeType: string }>;
	/** Override the configured image model. */
	model?: string;
}

export async function generateImage(
	input: GenerateImageInput,
): Promise<GeneratedImage | Error> {
	let baseURL: string;
	let apiKey: string;
	let configuredModel: string;
	try {
		const resolved = resolveImageModel();
		baseURL = resolved.baseURL;
		apiKey = resolved.apiKey;
		configuredModel = resolved.modelId;
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}

	const model = input.model || configuredModel;
	const inputImages = input.images ?? [];
	log.info(
		`[imagegen] generating with ${model}${inputImages.length ? ` (+${inputImages.length} input image${inputImages.length > 1 ? "s" : ""})` : ""}`,
	);

	const client = new OpenRouter({
		apiKey,
		serverURL: baseURL,
		retryConfig: { strategy: "none" },
	});

	const content = inputImages.length
		? [
				{ type: "text" as const, text: input.prompt },
				...inputImages.map((img) => ({
					type: "image_url" as const,
					imageUrl: {
						url: `data:${img.mimeType};base64,${img.bytes.toString("base64")}`,
					},
				})),
			]
		: input.prompt;

	try {
		const response = await client.chat.send({
			chatRequest: {
				model,
				modalities: ["image", "text"],
				messages: [{ role: "user", content }],
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

// ── Helpers ────────────────────────────────────────────────────────────────

function decodeDataUrl(dataUrl: string): GeneratedImage | Error {
	const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) {
		return new Error("Image response was not a base64 data URL");
	}
	const mimeType = match[1] ?? "image/png";
	const base64 = match[2] ?? "";
	return { bytes: Buffer.from(base64, "base64"), mimeType };
}

function trunc(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n…[truncated: ${text.length - max} chars omitted]`;
}
