import { config } from '../config';
import type { InboundMessage } from '../types';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

type LimitKind = 'messages' | 'modelCalls';

const windows: Record<LimitKind, Map<string, number[]>> = {
  messages: new Map(),
  modelCalls: new Map(),
};

function check(kind: LimitKind, chatId: string, now = Date.now()): RateLimitResult {
  const { max, windowMs } = config.rateLimits[kind];
  const cutoff = now - windowMs;

  let timestamps = windows[kind].get(chatId);
  if (!timestamps) {
    timestamps = [];
    windows[kind].set(chatId, timestamps);
  }

  // Prune expired entries
  while (timestamps.length > 0 && timestamps[0]! < cutoff) {
    timestamps.shift();
  }

  if (timestamps.length >= max) {
    const retryAfterMs = timestamps[0]! - cutoff;
    return { allowed: false, retryAfterMs };
  }

  timestamps.push(now);
  return { allowed: true };
}

/** Message-level gate — called by pipeline before any LLM work. */
export function checkMessageRate(msg: InboundMessage): RateLimitResult {
  return check('messages', msg.chatId);
}

/** LLM-call-level gate — called by model-router before each LLM invocation. */
export function checkModelRate(chatId: string): RateLimitResult {
  return check('modelCalls', chatId);
}

/** Test-only: clear all sliding-window state. */
export function _resetForTest(): void {
  windows.messages.clear();
  windows.modelCalls.clear();
}
