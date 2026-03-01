import type { OutboundMessage } from '../types';

/**
 * Per-chat send queue: ensures message ordering, deduplication by composite key,
 * WhatsApp rate-limit backoff, and retry.
 */
export class SendQueue {
  constructor(private readonly _chatId: string) {}

  enqueue(_msg: OutboundMessage): void {
    throw new Error('TODO: not implemented');
  }
}

/** Convenience wrapper — enqueues a single message on the appropriate queue. */
export function enqueueMessage(_msg: OutboundMessage): void {
  throw new Error('TODO: not implemented');
}
