import type { WASocket } from '@whiskeysockets/baileys';

let socket: WASocket | null = null;

/**
 * Initialize Baileys, handle QR pairing on first run, and manage reconnects.
 * Returns the active WASocket once connected.
 */
export async function startConnection(): Promise<WASocket> {
  throw new Error('TODO: not implemented');
}

export function getSocket(): WASocket {
  if (!socket) throw new Error('WhatsApp socket not initialized — call startConnection() first');
  return socket;
}
