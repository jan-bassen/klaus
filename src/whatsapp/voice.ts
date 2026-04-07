/**
 * STT transcription via ElevenLabs Scribe.
 */

import path from "node:path";
import { log } from "@/logger";
import { settings } from "@/settings";

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
	form.append("model_id", settings.models.stt);
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
			log.warn("[voice] Scribe API error", { status: res.status, body });
			return new Error(`Scribe API error ${res.status}: ${body}`);
		}

		const json = (await res.json()) as { text?: string };

		return json.text ?? "";
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}
