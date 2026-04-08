/**
 * Text-to-speech output via ElevenLabs.
 * Returns a Buffer containing MP3 audio to be sent as a WhatsApp voice message.
 */

import { log } from "@/logger";
import { settings } from "@/settings";

const TTS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";

/**
 * Convert text to speech using ElevenLabs.
 * Returns a Buffer (MP3 audio) or an Error value on failure.
 */
export async function textToSpeech(text: string): Promise<Buffer | Error> {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	if (!apiKey) return new Error("textToSpeech: ELEVENLABS_API_KEY not set");
	const voiceId = settings.tts.voiceId;
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
			body: JSON.stringify({ text, model_id: settings.tts.model }),
		});

		if (!res.ok) {
			const body = await res.text();
			log.warn("[tts] ElevenLabs API error", { status: res.status, body });
			return new Error(`TTS API error ${res.status}: ${body}`);
		}

		return Buffer.from(await res.arrayBuffer());
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}
