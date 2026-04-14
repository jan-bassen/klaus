/**
 * Voice handling: STT transcription, TTS synthesis, and voice transcript rewriting.
 */

import path from "node:path";
import { settings } from "@/config";
import { log } from "@/logger";

// -- STT (Speech-to-Text) --

const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";

/**
 * Transcribe an audio file using ElevenLabs Scribe.
 * Returns the transcript string, or an Error value on failure.
 */
export async function transcribe(
	filePath: string,
	mimeType: string,
): Promise<string | Error> {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	if (!apiKey) return new Error("transcribe: ELEVENLABS_API_KEY not set");

	const blob = Bun.file(filePath);
	const fileName = path.basename(filePath);

	const form = new FormData();
	form.append("model_id", settings.stt.model);
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
			signal: AbortSignal.timeout(settings.stt.timeoutMs),
		});

		if (!res.ok) {
			const body = await res.text();
			log.warn(`[voice] Scribe API error (${res.status})`, { body });
			return new Error(`Scribe API error ${res.status}: ${body}`);
		}

		const json = (await res.json()) as { text?: string };

		return json.text ?? "";
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}

// -- TTS (Text-to-Speech) --

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
			log.warn(`[tts] ElevenLabs API error (${res.status})`, { body });
			return new Error(`TTS API error ${res.status}: ${body}`);
		}

		return Buffer.from(await res.arrayBuffer());
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}

// -- Voice transcript rewriting --

function rewriteAgentPrefix(
	text: string,
	knownAgents: ReadonlySet<string>,
	triggers: readonly string[],
): string {
	const lower = text.toLowerCase();

	for (const trigger of triggers) {
		const prefix = `${trigger} `;
		if (!lower.startsWith(prefix)) continue;

		const afterTrigger = text.slice(prefix.length);
		const match = afterTrigger.match(/^([\w-]+)[,.]?\s*(.*)/s);
		if (!match?.[1]) continue;

		const candidate = match[1].toLowerCase();
		if (knownAgents.has(candidate)) {
			const remainder = match[2] ?? "";
			return remainder ? `@${candidate} ${remainder}` : `@${candidate}`;
		}
	}

	// Bare agent name at start: "fitness, help me" or "fitness help me"
	const bareMatch = lower.match(/^([\w-]+)[,]\s*/);
	if (bareMatch?.[1] && knownAgents.has(bareMatch[1])) {
		const remainder = text.slice(bareMatch[0].length);
		return remainder ? `@${bareMatch[1]} ${remainder}` : `@${bareMatch[1]}`;
	}

	return text;
}

export function rewriteVoiceTranscript(
	text: string,
	knownAgents: ReadonlySet<string>,
	agentTriggers: readonly string[],
): string {
	if (!text) return text;
	return rewriteAgentPrefix(text, knownAgents, agentTriggers);
}
