import { beforeEach, describe, expect, test } from 'bun:test';
import { config } from '@/config';
import { _resetForTest, checkMessageRate, checkModelRate } from '@/core/rate-limiter';
import type { InboundMessage } from '@/types';

function makeMsg(chatId = 'user@s.whatsapp.net'): InboundMessage {
  return {
    kind: 'whatsapp',
    id: crypto.randomUUID(),
    chatId,
    senderId: chatId,
    text: 'hi',
    timestamp: new Date(),
    messageKey: {},
  };
}

beforeEach(() => {
  _resetForTest();
});

describe('checkMessageRate', () => {
  test('allows messages under the limit', () => {
    const msg = makeMsg();
    for (let i = 0; i < config.rateLimits.messages.max; i++) {
      expect(checkMessageRate(msg).allowed).toBe(true);
    }
  });

  test('blocks at max + 1 within the window', () => {
    const msg = makeMsg();
    for (let i = 0; i < config.rateLimits.messages.max; i++) {
      checkMessageRate(msg);
    }
    const result = checkMessageRate(msg);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test('returns retryAfterMs indicating when the window opens', () => {
    const msg = makeMsg();
    for (let i = 0; i < config.rateLimits.messages.max; i++) {
      checkMessageRate(msg);
    }
    const result = checkMessageRate(msg);
    expect(result.retryAfterMs).toBeDefined();
    expect(result.retryAfterMs!).toBeLessThanOrEqual(config.rateLimits.messages.windowMs);
  });
});

describe('checkModelRate', () => {
  test('allows calls under the limit', () => {
    for (let i = 0; i < config.rateLimits.modelCalls.max; i++) {
      expect(checkModelRate().allowed).toBe(true);
    }
  });

  test('blocks at max + 1 within the window', () => {
    for (let i = 0; i < config.rateLimits.modelCalls.max; i++) {
      checkModelRate();
    }
    const result = checkModelRate();
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });
});

describe('cross-gate independence', () => {
  test('message and model-call limits do not interfere', () => {
    const msg = makeMsg();

    for (let i = 0; i < config.rateLimits.messages.max; i++) {
      checkMessageRate(msg);
    }
    expect(checkMessageRate(msg).allowed).toBe(false);

    // Model-call window should still be open
    expect(checkModelRate().allowed).toBe(true);
  });
});
