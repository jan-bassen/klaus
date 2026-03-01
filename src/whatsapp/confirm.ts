import type { InboundMessage } from '../types';

export type ConfirmResult = 'confirmed' | 'rejected' | 'timeout';

/**
 * Send a confirmation prompt to the user (via WhatsApp reaction or message)
 * and wait for a 👍 (confirmed) or 👎 (rejected) reaction.
 * Times out after the specified duration.
 */
export async function awaitConfirmation(
  _msg: InboundMessage,
  _prompt: string,
  _timeoutMs?: number,
): Promise<ConfirmResult> {
  throw new Error('TODO: not implemented');
}
