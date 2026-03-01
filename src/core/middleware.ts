import { config } from '../config';
import type { InboundMessage } from '../types';

export interface AuthResult {
  allowed: boolean;
}

// --- Allowlist ---

let allowedSet: Set<string> | null = null;

function getAllowedSet(): Set<string> {
  if (allowedSet) return allowedSet;
  const raw = process.env.ALLOWED_CHAT_IDS ?? '';
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  allowedSet = new Set(ids);
  return allowedSet;
}

/** Verify that the sender's chatId is in the configured allowlist. Fail-closed: empty list blocks all. */
export function checkAllowlist(msg: InboundMessage): AuthResult {
  const set = getAllowedSet();
  if (set.size === 0) return { allowed: false };
  return { allowed: set.has(msg.chatId) };
}

// --- Debounce ---

interface DebounceEntry {
  messages: InboundMessage[];
  resolve: (msgs: InboundMessage[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, DebounceEntry>();

/**
 * Debounce rapid successive messages from the same chatId.
 * The first caller's promise resolves with the full batch when the window closes.
 * Subsequent callers within the same window resolve with [] (skip signal).
 */
export function debounce(msg: InboundMessage): Promise<InboundMessage[]> {
  const existing = pending.get(msg.chatId);

  if (existing) {
    existing.messages.push(msg);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flush(msg.chatId), config.debounce.windowMs);
    return Promise.resolve([]);
  }

  return new Promise<InboundMessage[]>((resolve) => {
    const timer = setTimeout(() => flush(msg.chatId), config.debounce.windowMs);
    pending.set(msg.chatId, { messages: [msg], resolve, timer });
  });
}

function flush(chatId: string): void {
  const entry = pending.get(chatId);
  if (!entry) return;
  pending.delete(chatId);
  entry.resolve(entry.messages);
}

/** Test-only: clear all pending debounce state and cancel timers. */
export function _resetDebounceForTest(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
  }
  pending.clear();
}

/** Test-only: clear cached allowlist so env changes take effect. */
export function _resetAllowlistForTest(): void {
  allowedSet = null;
}
