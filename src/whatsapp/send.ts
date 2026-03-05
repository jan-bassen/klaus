import type { AnyMessageContent, WASocket } from '@whiskeysockets/baileys';
import type { OutboundMessage } from '@/types';
import { config } from '@/config';
import { log } from '@/logger';

// Module-level socket reference set by attachReceiveHandler at startup.
let _socket: WASocket | null = null;

/** Called by receive.ts when the Baileys socket is established. */
export function setSocket(socket: WASocket): void {
  _socket = socket;
}

/**
 * Returns a promise that resolves when the current send queue has fully drained.
 * Use during graceful shutdown to avoid dropping in-flight messages.
 */
export function drainQueue(): Promise<void> {
  return _queue;
}

// Single FIFO promise chain for message ordering.
let _queue: Promise<void> = Promise.resolve();
// In-memory dedup: skip re-sending a key within the current process lifetime.
// Capped at MAX_SEEN_SIZE to prevent unbounded memory growth in long-running processes.
const _seen = new Set<string>();
const MAX_SEEN_SIZE = 10_000;

/**
 * Enqueue an outbound message for delivery: ensures FIFO ordering, deduplication
 * by composite key, WhatsApp rate-limit backoff, and retry.
 */
export function enqueueMessage(msg: OutboundMessage): void {
  if (_seen.has(msg.dedupKey)) return;
  if (_seen.size >= MAX_SEEN_SIZE) _seen.delete(_seen.values().next().value!);
  _seen.add(msg.dedupKey);

  _queue = _queue
    .then(() => sendWithRetry(msg))
    .catch((err: unknown) => {
      log.error('[send] failed after retries', {
        chatId: msg.chatId,
        dedupKey: msg.dedupKey,
        error: err instanceof Error ? err.message : String(err),
      });
      // Best-effort delivery-failure notification so the user knows the message was lost.
      // One attempt only, no retry, to avoid an infinite failure loop.
      if (_socket) {
        _socket.sendMessage(msg.chatId, { text: 'Failed to deliver my last message. Please try again.' }).catch((sendErr: unknown) => {
          log.warn('[send] could not notify user of delivery failure', {
            chatId: msg.chatId,
            error: sendErr instanceof Error ? sendErr.message : String(sendErr),
          });
        });
      }
    });
}

function mediaContent(content: Buffer, mimeType?: string): AnyMessageContent {
  const mime = mimeType ?? 'application/octet-stream';
  if (mime.startsWith('image/')) return { image: content, mimetype: mime };
  if (mime.startsWith('audio/')) return { audio: content, mimetype: mime };
  if (mime.startsWith('video/')) return { video: content, mimetype: mime };
  return { document: content, mimetype: mime };
}

async function sendWithRetry(msg: OutboundMessage, attempt = 1): Promise<void> {
  if (!_socket) throw new Error('No WhatsApp socket — call setSocket() before sending');

  const waContent =
    typeof msg.content === 'string'
      ? { text: msg.content }
      : mediaContent(msg.content, msg.mimeType);

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
