import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  _resetDebounceForTest,
  checkAllowlist,
  debounce,
} from '@/core/middleware';
import type { InboundMessage } from '@/types';

function makeMsg(chatId = 'user@s.whatsapp.net', text = 'hi'): InboundMessage {
  return {
    kind: 'whatsapp',
    id: crypto.randomUUID(),
    chatId,
    senderId: chatId,
    text,
    timestamp: new Date(),
    messageKey: {},
  };
}

// --- Allowlist ---

describe('checkAllowlist', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ALLOWED_CHAT_ID;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ALLOWED_CHAT_ID;
    } else {
      process.env.ALLOWED_CHAT_ID = originalEnv;
    }
  });

  test('allows a chatId matching the configured ID', () => {
    process.env.ALLOWED_CHAT_ID = 'user@s.whatsapp.net';
    expect(checkAllowlist(makeMsg('user@s.whatsapp.net')).allowed).toBe(true);
  });

  test('blocks a chatId not matching the configured ID', () => {
    process.env.ALLOWED_CHAT_ID = 'allowed@s.whatsapp.net';
    expect(checkAllowlist(makeMsg('stranger@s.whatsapp.net')).allowed).toBe(false);
  });

  test('blocks all when env var is empty', () => {
    process.env.ALLOWED_CHAT_ID = '';
    expect(checkAllowlist(makeMsg()).allowed).toBe(false);
  });

  test('blocks all when env var is unset', () => {
    delete process.env.ALLOWED_CHAT_ID;
    expect(checkAllowlist(makeMsg()).allowed).toBe(false);
  });
});

// --- Debounce ---

describe('debounce', () => {
  beforeEach(() => {
    _resetDebounceForTest();
  });

  afterEach(() => {
    _resetDebounceForTest();
  });

  test('single message resolves after the window with a 1-element array', async () => {
    const msg = makeMsg();
    const batch = await debounce(msg);
    expect(batch).toHaveLength(1);
    expect(batch[0]!.id).toBe(msg.id);
  });

  test('multiple rapid messages are batched', async () => {
    const m1 = makeMsg('user@s.whatsapp.net', 'first');
    const m2 = makeMsg('user@s.whatsapp.net', 'second');
    const m3 = makeMsg('user@s.whatsapp.net', 'third');

    const batchPromise = debounce(m1);
    const skip1 = await debounce(m2);
    const skip2 = await debounce(m3);

    expect(skip1).toHaveLength(0);
    expect(skip2).toHaveLength(0);

    const batch = await batchPromise;
    expect(batch).toHaveLength(3);
    expect(batch.map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });

  test('only the first caller gets the batch; subsequent callers get []', async () => {
    const m1 = makeMsg('user@s.whatsapp.net');
    const m2 = makeMsg('user@s.whatsapp.net');

    const firstPromise = debounce(m1);
    const secondResult = await debounce(m2);

    expect(secondResult).toHaveLength(0);
    const firstResult = await firstPromise;
    expect(firstResult).toHaveLength(2);
  });
});
