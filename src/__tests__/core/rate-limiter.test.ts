import { beforeEach, describe, expect, test } from 'bun:test';
import { config } from '../../config';
import { _resetForTest, checkMessageRate, checkModelRate } from '../../core/rate-limiter';
import type { InboundMessage } from '../../types';

function makeMsg(chatId = 'user@s.whatsapp.net'): InboundMessage {
  return {
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

  test('different chatIds have independent windows', () => {
    const msgA = makeMsg('a@s.whatsapp.net');
    const msgB = makeMsg('b@s.whatsapp.net');

    for (let i = 0; i < config.rateLimits.messages.max; i++) {
      checkMessageRate(msgA);
    }

    expect(checkMessageRate(msgA).allowed).toBe(false);
    expect(checkMessageRate(msgB).allowed).toBe(true);
  });
});

describe('checkModelRate', () => {
  test('allows calls under the limit', () => {
    for (let i = 0; i < config.rateLimits.modelCalls.max; i++) {
      expect(checkModelRate('chat1').allowed).toBe(true);
    }
  });

  test('blocks at max + 1 within the window', () => {
    for (let i = 0; i < config.rateLimits.modelCalls.max; i++) {
      checkModelRate('chat1');
    }
    const result = checkModelRate('chat1');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test('different chatIds have independent windows', () => {
    for (let i = 0; i < config.rateLimits.modelCalls.max; i++) {
      checkModelRate('a');
    }
    expect(checkModelRate('a').allowed).toBe(false);
    expect(checkModelRate('b').allowed).toBe(true);
  });
});

describe('cross-gate independence', () => {
  test('message and model-call limits do not interfere', () => {
    const msg = makeMsg('shared@s.whatsapp.net');

    for (let i = 0; i < config.rateLimits.messages.max; i++) {
      checkMessageRate(msg);
    }
    expect(checkMessageRate(msg).allowed).toBe(false);

    // Model-call window for the same chatId should still be open
    expect(checkModelRate('shared@s.whatsapp.net').allowed).toBe(true);
  });
});
