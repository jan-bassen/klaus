import type { WAMessageKey } from '@whiskeysockets/baileys';
import { getSocket } from './connection';
import { log } from '@/logger';

/**
 * Send a reaction emoji to a specific message.
 * Pass an empty string as emoji to remove an existing reaction.
 * Errors are returned as values — reactions are best-effort UX.
 */
export async function sendReaction(
  chatId: string,
  msgKey: WAMessageKey,
  emoji: string,
): Promise<void | Error> {
  try {
    await getSocket().sendMessage(chatId, { react: { key: msgKey, text: emoji } });
    log.debug('[reactions] sent', { chatId, emoji });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn('[reactions] failed to send reaction', { chatId, emoji, error: error.message });
    return error;
  }
}
