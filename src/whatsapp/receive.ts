import type { WASocket } from '@whiskeysockets/baileys';
import type { InboundMessage } from '../types';

/**
 * Attach the message event handler to the Baileys socket.
 * Normalizes raw Baileys messages into InboundMessage and hands them to pipeline.handleTurn.
 * Pure transport — no business logic.
 */
export function attachReceiveHandler(_socket: WASocket): void {
  throw new Error('TODO: not implemented');
}

export function normalizeMessage(_raw: unknown): InboundMessage | null {
  throw new Error('TODO: not implemented');
}
