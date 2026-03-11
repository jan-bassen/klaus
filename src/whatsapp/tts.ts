/**
 * Text-to-speech output via ElevenLabs.
 * Returns a Buffer containing MP3 audio to be sent as a WhatsApp voice message.
 */

import { config } from "@/config";
import { db } from "@/db/client";
import { costs } from "@/db/schema";
import { log } from "@/logger";

const TTS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";

/**
 * Convert text to speech using ElevenLabs.
 * Returns a Buffer (MP3 audio) or an Error value on failure.
 */
export async function textToSpeech(
	text: string,
	chatId?: string,
): Promise<Buffer | Error> {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	if (!apiKey) return new Error("textToSpeech: ELEVENLABS_API_KEY not set");
	const voiceId = config.tts.voiceId;
	if (!voiceId) return new Error("textToSpeech: config.tts.voiceId is not set");

	const url = `${TTS_BASE}/${voiceId}`;

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"xi-api-key": apiKey,
				"Content-Type": "application/json",
				Accept: "audio/mpeg",
			},
			body: JSON.stringify({ text, model_id: config.models.tts }),
		});

		if (!res.ok) {
			const body = await res.text();
			log.warn("[tts] ElevenLabs API error", { status: res.status, body });
			return new Error(`TTS API error ${res.status}: ${body}`);
		}

		const chars = text.length;
		const costUsd = (chars / 1_000_000) * config.apiPricing.tts.perMChars;
		db.insert(costs)
			.values({
				chatId,
				service: "tts",
				units: chars,
				costUsd: String(costUsd),
			})
			.catch((err) =>
				log.warn("[cost] failed to record tts cost", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);

		return Buffer.from(await res.arrayBuffer());
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}
