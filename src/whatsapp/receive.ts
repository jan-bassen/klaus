import path from 'path';
import { mkdir } from 'node:fs/promises';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { downloadMediaMessage, normalizeMessageContent } from '@whiskeysockets/baileys';
import type { InboundMessage } from '@/types';
import { setSocket, enqueueMessage } from './send';
import { handleTurn } from '@/core/pipeline';
import { saveFile } from '@/db/write';
import { log } from '@/logger';
import { config } from '@/config';
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024; // 64 MB

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
};

function mimeToExt(mime: string): string {
  return MIME_TO_EXT[mime] ?? mime.split('/')[1] ?? 'bin';
}

/**
 * Attach the message event handler to the Baileys socket.
 * For each incoming message: normalizes it to InboundMessage (including media
 * auto-persist) then hands it to pipeline.handleTurn.
 * Pure transport — no business logic.
 */
export function attachReceiveHandler(socket: WASocket): void {
  setSocket(socket);

  socket.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;
    for (const raw of msgs) {
      const msg = await normalizeMessage(raw);
      if (msg) {
        log.info('[receive] message', { chatId: msg.chatId, text: msg.text?.slice(0, 40), kind: msg.kind });
        try {
          await handleTurn(msg);
        } catch (err) {
          // Should not happen — pipeline has its own top-level catch — but guard here
          // anyway so a bug in the pipeline itself cannot crash the event listener.
          log.error('[receive] unhandled error from handleTurn', {
            chatId: msg.chatId,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
          // Last-resort notification: pipeline's own catch should have already sent this,
          // but if it threw itself the user would otherwise get nothing.
          try {
            enqueueMessage({
              chatId: msg.chatId,
              content: 'Something went wrong. Please try again.',
              dedupKey: `${msg.id}:receive-error`,
            });
          } catch { /* best-effort */ }
        }
      }
    }
  });
}

/**
 * Normalize a raw Baileys message into an InboundMessage.
 * Downloads and persists media blobs (voice, images, documents) before returning.
 *
 * Returns null for outbound, non-media/text, or unsupported message types.
 */
export async function normalizeMessage(raw: unknown): Promise<InboundMessage | null> {
  const m = raw as {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string; participant?: string };
    message?: {
      conversation?: string;
      extendedTextMessage?: {
        text?: string;
        contextInfo?: {
          stanzaId?: string;
          quotedMessage?: {
            conversation?: string;
            extendedTextMessage?: { text?: string };
          };
        };
      };
      imageMessage?: { mimetype?: string; caption?: string; fileLength?: number | bigint };
      audioMessage?: { mimetype?: string; ptt?: boolean; fileLength?: number | bigint };
      documentMessage?: { mimetype?: string; fileName?: string; caption?: string; fileLength?: number | bigint };
    };
    messageTimestamp?: number | bigint;
  };

  // Skip messages we sent and messages without a remote JID
  if (!m?.key?.remoteJid) return null;
  if (m.key.fromMe) {
    log.debug('[receive] skip fromMe', { remoteJid: m.key.remoteJid });
    return null;
  }
  if (!m.message) {
    log.debug('[receive] skip no-message', { remoteJid: m.key.remoteJid });
    return null;
  }

  // Unwrap Baileys envelope types (ephemeral, viewOnce, editedMessage, etc.)
  // so the inner extendedTextMessage / imageMessage / etc. are always at the top level.
  const normalized = normalizeMessageContent((raw as WAMessage).message) ?? m.message;

  // Extract text — conversation (1:1) or extendedTextMessage (quoted/formatted).
  // Use || (not ??) because conversation can be an empty string "" when the actual
  // text lives in extendedTextMessage.text.
  const text =
    normalized.conversation || normalized.extendedTextMessage?.text || undefined;

  // Extract quoted message context when this message is a reply
  const contextInfo = normalized.extendedTextMessage?.contextInfo;
  let quotedMessage: InboundMessage['quotedMessage'] | undefined;
  if (contextInfo?.quotedMessage && contextInfo.stanzaId) {
    const qm = contextInfo.quotedMessage;
    const quotedText = qm.conversation || qm.extendedTextMessage?.text || undefined;
    quotedMessage = { externalId: contextInfo.stanzaId, ...(quotedText ? { text: quotedText } : {}) };
  }

  const imgMsg  = normalized.imageMessage;
  const audioMsg = normalized.audioMessage;
  const docMsg  = normalized.documentMessage;
  const mediaMsg = imgMsg ?? audioMsg ?? docMsg ?? null;

  // Skip messages with neither text nor supported media nor a quoted reply
  if (!text && !mediaMsg && !quotedMessage) {
    log.debug('[receive] skip no-text no-media', { remoteJid: m.key.remoteJid });
    return null;
  }

  const rawTs = m.messageTimestamp;
  const tsSeconds = typeof rawTs === 'bigint' ? Number(rawTs) : (rawTs ?? Date.now() / 1000);

  // Caption text from image/document (used if no explicit text field)
  const effectiveText = text ?? imgMsg?.caption ?? docMsg?.caption ?? undefined;

  let media: InboundMessage['media'] | undefined;

  if (mediaMsg) {

    const rawMime =
      imgMsg?.mimetype ?? audioMsg?.mimetype ?? docMsg?.mimetype ?? 'application/octet-stream';
    // Strip "; codecs=..." suffix if present
    const mimeType = rawMime.split(';')[0]!.trim();

    const fileLength = Number(imgMsg?.fileLength ?? audioMsg?.fileLength ?? docMsg?.fileLength ?? 0);
    if (fileLength > MAX_DOWNLOAD_BYTES) {
      log.warn('[receive] media too large — skipping download', {
        remoteJid: m.key.remoteJid,
        fileLength,
        maxBytes: MAX_DOWNLOAD_BYTES,
      });
    } else try {
      const buffer = await downloadMediaMessage(raw as WAMessage, 'buffer', {});

      const date = new Date().toISOString().slice(0, 10);
      const id = crypto.randomUUID();
      const ext = mimeToExt(mimeType);
      const dir = path.join(config.files.dir, date);
      const filePath = path.join(dir, `${id}.${ext}`);

      await mkdir(dir, { recursive: true });
      await Bun.write(filePath, buffer as Buffer);

      const sizeBytes = (buffer as Buffer).byteLength;
      const saved = await saveFile({ path: filePath, mimeType, sizeBytes });

      const fileName = docMsg?.fileName;
      if (saved instanceof Error) {
        log.warn('[receive] saveFile failed — media not tracked in DB', {
          remoteJid: m.key.remoteJid,
          error: saved.message,
        });
        media = { fileId: crypto.randomUUID(), path: filePath, mimeType, ...(fileName ? { fileName } : {}) };
      } else {
        media = { fileId: saved.id, path: filePath, mimeType, ...(fileName ? { fileName } : {}) };
      }
    } catch (err) {
      log.warn('[receive] media download failed — continuing as text-only', {
        remoteJid: m.key.remoteJid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Nothing actionable — skip
  if (!effectiveText && !media && !quotedMessage) {
    log.debug('[receive] skip no content', { remoteJid: m.key.remoteJid });
    return null;
  }

  return {
    kind: 'whatsapp',
    id: m.key.id ?? crypto.randomUUID(),
    chatId: m.key.remoteJid,
    senderId: m.key.participant ?? m.key.remoteJid,
    ...(effectiveText ? { text: effectiveText } : {}),
    ...(media ? { media } : {}),
    ...(quotedMessage ? { quotedMessage } : {}),
    timestamp: new Date(tsSeconds * 1000),
    messageKey: m.key as Record<string, unknown>,
  };
}
