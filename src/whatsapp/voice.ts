/**
 * STT transcription and vision image analysis.
 * Uses the model-router with the `stt` and `vision` tiers respectively.
 */

export async function transcribe(_audioBuffer: Buffer, _mimeType: string): Promise<string> {
  throw new Error('TODO: not implemented');
}

export async function analyzeImage(_imageBuffer: Buffer, _mimeType: string): Promise<string> {
  throw new Error('TODO: not implemented');
}
