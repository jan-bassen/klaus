import { getSocket } from './connection';
import { log } from '@/logger';

/**
 * Send a "composing" (typing...) presence update for the given chat.
 * Best-effort — errors are silently swallowed.
 */
export async function startTyping(chatId: string): Promise<void> {
  try {
    await getSocket().sendPresenceUpdate('composing', chatId);
  } catch (err) {
    log.debug('[presence] startTyping failed', { chatId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Send a "paused" presence update to clear the typing indicator.
 * Best-effort — errors are silently swallowed.
 */
export async function stopTyping(chatId: string): Promise<void> {
  try {
    await getSocket().sendPresenceUpdate('paused', chatId);
  } catch (err) {
    log.debug('[presence] stopTyping failed', { chatId, error: err instanceof Error ? err.message : String(err) });
  }
}
