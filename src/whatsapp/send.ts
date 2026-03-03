import type { WASocket } from '@whiskeysockets/baileys';
import type { OutboundMessage } from '@/types';
import { config } from '@/config';
import { log } from '@/logger';

// Module-level socket reference set by attachReceiveHandler at startup.
let _socket: WASocket | null = null;

/** Called by receive.ts when the Baileys socket is established. */
export function setSocket(socket: WASocket): void {
  _socket = socket;
}

// Single FIFO promise chain for message ordering.
let _queue: Promise<void> = Promise.resolve();
// In-memory dedup: skip re-sending a key within the current process lifetime.
const _seen = new Set<string>();

/**
 * Enqueue an outbound message for delivery: ensures FIFO ordering, deduplication
 * by composite key, WhatsApp rate-limit backoff, and retry.
 */
export function enqueueMessage(msg: OutboundMessage): void {
  if (_seen.has(msg.dedupKey)) return;
  _seen.add(msg.dedupKey);

  _queue = _queue
    .then(() => sendWithRetry(msg))
    .catch((err: unknown) => {
      log.error('[send] failed after retries', {
        dedupKey: msg.dedupKey,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

async function sendWithRetry(msg: OutboundMessage, attempt = 1): Promise<void> {
  if (!_socket) throw new Error('No WhatsApp socket — call setSocket() before sending');

  const waContent =
    typeof msg.content === 'string'
      ? { text: msg.content }
      : { image: msg.content, mimetype: msg.mimeType ?? 'application/octet-stream' };

  try {
    if (attempt > 1) {
      log.info('[send] retry attempt', { dedupKey: msg.dedupKey, attempt });
    }
    await _socket.sendMessage(msg.chatId, waContent);
    log.info('[send] sent', { dedupKey: msg.dedupKey });
    await new Promise<void>((r) => setTimeout(r, config.send.interMessageDelayMs));
  } catch (err) {
    if (attempt < 3) {
      await new Promise<void>((r) => setTimeout(r, 1_000 * attempt));
      return sendWithRetry(msg, attempt + 1);
    }
    throw err;
  }
}
