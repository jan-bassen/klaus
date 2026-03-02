import { config } from '@/config';
import type { InboundMessage } from '@/types';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

type LimitKind = 'messages' | 'modelCalls';

const windows: Record<LimitKind, number[]> = {
  messages: [],
  modelCalls: [],
};

function check(kind: LimitKind, now = Date.now()): RateLimitResult {
  const { max, windowMs } = config.rateLimits[kind];
  const cutoff = now - windowMs;
  const timestamps = windows[kind];

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
export function checkMessageRate(_msg: InboundMessage): RateLimitResult {
  return check('messages');
}

/** LLM-call-level gate — called by model-router before each LLM invocation. */
export function checkModelRate(): RateLimitResult {
  return check('modelCalls');
}

/** Test-only: clear all sliding-window state. */
export function _resetForTest(): void {
  windows.messages = [];
  windows.modelCalls = [];
}
