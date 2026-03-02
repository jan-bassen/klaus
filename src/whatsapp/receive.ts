import type { WASocket } from '@whiskeysockets/baileys';
import type { InboundMessage } from '@/types';
import { setSocket } from './send';
import { handleTurn } from '@/core/pipeline';

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
      if (msg) await handleTurn(msg);
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
  if (!m?.key?.remoteJid || m.key.fromMe) return null;
  if (!m.message) return null;

  // Extract text — conversation (1:1) or extendedTextMessage (quoted/formatted)
  const text =
    m.message.conversation ?? m.message.extendedTextMessage?.text ?? null;

  // Skip non-text messages (images, audio, etc.) — deferred to voice/vision step
  if (!text) return null;

  const rawTs = m.messageTimestamp;
  const tsSeconds = typeof rawTs === 'bigint' ? Number(rawTs) : (rawTs ?? Date.now() / 1000);

  return {
    id: m.key.id ?? crypto.randomUUID(),
    chatId: m.key.remoteJid,
    senderId: m.key.participant ?? m.key.remoteJid,
    text,
    timestamp: new Date(tsSeconds * 1000),
    messageKey: m.key as Record<string, unknown>,
  };
}
