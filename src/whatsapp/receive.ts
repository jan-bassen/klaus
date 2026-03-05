import type { WASocket } from '@whiskeysockets/baileys';
import type { InboundMessage } from '@/types';
import { setSocket, enqueueMessage } from './send';
import { handleTurn } from '@/core/pipeline';
import { log } from '@/logger';

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
      const msg = normalizeMessage(raw);
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
 * V1: text messages only. Media handling (voice, images) deferred to Step 4.
 *
 * Returns null for outbound, non-text, or unsupported message types.
 */
export function normalizeMessage(raw: unknown): InboundMessage | null {
  const m = raw as {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string; participant?: string };
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
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

  // Extract text — conversation (1:1) or extendedTextMessage (quoted/formatted)
  const text =
    m.message.conversation ?? m.message.extendedTextMessage?.text ?? null;

  // Skip non-text messages (images, audio, etc.) — deferred to voice/vision step
  if (!text) {
    log.debug('[receive] skip no-text', { remoteJid: m.key.remoteJid });
    return null;
  }

  const rawTs = m.messageTimestamp;
  const tsSeconds = typeof rawTs === 'bigint' ? Number(rawTs) : (rawTs ?? Date.now() / 1000);

  return {
    kind: 'whatsapp',
    id: m.key.id ?? crypto.randomUUID(),
    chatId: m.key.remoteJid,
    senderId: m.key.participant ?? m.key.remoteJid,
    text,
    timestamp: new Date(tsSeconds * 1000),
    messageKey: m.key as Record<string, unknown>,
  };
}
