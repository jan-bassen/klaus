import { config } from '@/config';
import type { InboundMessage } from '@/types';

export interface AuthResult {
  allowed: boolean;
}

// --- Allowlist ---

/** Verify the sender's chatId matches the single configured chat. Fail-closed: unset env blocks all. */
export function checkAllowlist(msg: InboundMessage): AuthResult {
  const allowed = process.env.ALLOWED_CHAT_ID ?? '';
  return { allowed: allowed !== '' && msg.chatId === allowed };
}

// --- Debounce ---

interface DebounceEntry {
  messages: InboundMessage[];
  resolve: (msgs: InboundMessage[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

let pending: DebounceEntry | null = null;

/**
 * Debounce rapid successive messages within the debounce window.
 * The first caller's promise resolves with the full batch when the window closes.
 * Subsequent callers within the same window resolve with [] (skip signal).
 */
export function debounce(msg: InboundMessage): Promise<InboundMessage[]> {
  if (pending) {
    pending.messages.push(msg);
    clearTimeout(pending.timer);
    pending.timer = setTimeout(flush, config.debounce.windowMs);
    return Promise.resolve([]);
  }

  return new Promise<InboundMessage[]>((resolve) => {
    pending = { messages: [msg], resolve, timer: setTimeout(flush, config.debounce.windowMs) };
  });
}

function flush(): void {
  if (!pending) return;
  const entry = pending;
  pending = null;
  entry.resolve(entry.messages);
}

/** Test-only: clear pending debounce state and cancel timer. */
export function _resetDebounceForTest(): void {
  if (pending) clearTimeout(pending.timer);
  pending = null;
}
