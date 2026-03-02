import type { WASocket } from '@whiskeysockets/baileys';
import type { OutboundMessage } from '@/types';

// Module-level socket reference set by attachReceiveHandler at startup.
let _socket: WASocket | null = null;

/** Called by receive.ts when the Baileys socket is established. */
export function setSocket(socket: WASocket): void {
  _socket = socket;
}

// Per-chat promise chain for FIFO ordering.
const _queues = new Map<string, Promise<void>>();
// In-memory dedup: skip re-sending a key within the current process lifetime.
const _seen = new Set<string>();

/**
 * Per-chat send queue: ensures message ordering, deduplication by composite key,
 * WhatsApp rate-limit backoff, and retry.
 */
export class SendQueue {
  constructor(private readonly _chatId: string) {}

  enqueue(msg: OutboundMessage): void {
    if (_seen.has(msg.dedupKey)) return;
    _seen.add(msg.dedupKey);

    const prev = _queues.get(this._chatId) ?? Promise.resolve();
    const next = prev
      .then(() => sendWithRetry(msg))
      .catch((err: unknown) => {
        console.error(`[send] failed after retries for ${msg.dedupKey}:`, err);
      });
    _queues.set(this._chatId, next);
  }
}

async function sendWithRetry(msg: OutboundMessage, attempt = 1): Promise<void> {
  if (!_socket) throw new Error('No WhatsApp socket — call setSocket() before sending');

  const waContent =
    typeof msg.content === 'string'
      ? { text: msg.content }
      : { image: msg.content, mimetype: msg.mimeType ?? 'application/octet-stream' };

  try {
    await _socket.sendMessage(msg.chatId, waContent);
  } catch (err) {
    if (attempt < 3) {
      await new Promise<void>((r) => setTimeout(r, 1_000 * attempt));
      return sendWithRetry(msg, attempt + 1);
    }
    throw err;
  }
}

/**
 * Convenience wrapper — sends a single outbound message via the active Baileys socket.
 * Routes through SendQueue for ordering, dedup, and retry.
 */
export function enqueueMessage(msg: OutboundMessage): void {
  const q = new SendQueue(msg.chatId);
  q.enqueue(msg);
}
