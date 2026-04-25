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
import sharp from "sharp";
import { settings } from "@/infra/config";
import { log } from "@/infra/logger";

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
	const blob = Bun.file(filePath);

	const form = new FormData();
	form.append("model_id", settings.media.voice.stt.model);
	form.append(
		"file",
		new Blob([await blob.arrayBuffer()], { type: mimeType }),
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
	const raw = await Bun.file(filePath).arrayBuffer();
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
			return await Bun.file(cachePath).text();
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
		await Bun.write(cachePath, text);
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

// ── Image generation (stubbed in phase 2; implemented in phase 9) ─────────

export interface GeneratedImage {
	bytes: Buffer;
	mimeType: string;
	prompt: string;
}

/** Phase-2 placeholder. Phase 9 wires this to the configured provider. */
export async function generateImage(
	_prompt: string,
): Promise<GeneratedImage | Error> {
	return new Error("generateImage: not implemented yet (phase 9)");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function trunc(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n…[truncated: ${text.length - max} chars omitted]`;
}
