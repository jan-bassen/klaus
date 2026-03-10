/**
 * STT transcription via ElevenLabs Scribe.
 */

import path from 'path';
import { config } from '@/config';
import { db } from '@/db/client';
import { costs } from '@/db/schema';
import { log } from '@/logger';

const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

/**
 * Transcribe an audio file using ElevenLabs Scribe.
 * Returns the transcript string, or an Error value on failure.
 */
export async function transcribe(filePath: string, mimeType: string, chatId?: string): Promise<string | Error> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return new Error('transcribe: ELEVENLABS_API_KEY not set');

  const blob = Bun.file(filePath);
  const fileName = path.basename(filePath);

  const form = new FormData();
  form.append('model_id', config.models.stt);
  form.append('file', new Blob([await blob.arrayBuffer()], { type: mimeType }), fileName);

  try {
    const res = await fetch(SCRIBE_URL, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text();
      log.warn('[voice] Scribe API error', { status: res.status, body });
      return new Error(`Scribe API error ${res.status}: ${body}`);
    }

    const json = await res.json() as { text?: string };

    // Estimate audio duration from file size (OGG Opus ~16 kbps for WhatsApp voice messages).
    const estimatedSeconds = (blob.size * 8) / 16_000;
    const costUsd = (estimatedSeconds / 3600) * config.apiPricing.stt.perHour;
    db.insert(costs)
      .values({ ...(chatId ? { chatId } : {}), service: 'stt', units: Math.round(estimatedSeconds), costUsd: String(costUsd) })
      .catch((err) => log.warn('[cost] failed to record stt cost', { error: err instanceof Error ? err.message : String(err) }));

    return json.text ?? '';
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}
