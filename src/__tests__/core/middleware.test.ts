import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  _resetAllowlistForTest,
  _resetDebounceForTest,
  checkAllowlist,
  debounce,
} from '@/core/middleware';
import type { InboundMessage } from '@/types';

function makeMsg(chatId = 'user@s.whatsapp.net', text = 'hi'): InboundMessage {
  return {
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
    originalEnv = process.env.ALLOWED_CHAT_IDS;
    _resetAllowlistForTest();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ALLOWED_CHAT_IDS;
    } else {
      process.env.ALLOWED_CHAT_IDS = originalEnv;
    }
    _resetAllowlistForTest();
  });

  test('allows a chatId in the list', () => {
    process.env.ALLOWED_CHAT_IDS = 'user@s.whatsapp.net';
    expect(checkAllowlist(makeMsg('user@s.whatsapp.net')).allowed).toBe(true);
  });

  test('blocks a chatId not in the list', () => {
    process.env.ALLOWED_CHAT_IDS = 'allowed@s.whatsapp.net';
    expect(checkAllowlist(makeMsg('stranger@s.whatsapp.net')).allowed).toBe(false);
  });

  test('blocks all when env var is empty', () => {
    process.env.ALLOWED_CHAT_IDS = '';
    expect(checkAllowlist(makeMsg()).allowed).toBe(false);
  });

  test('blocks all when env var is unset', () => {
    delete process.env.ALLOWED_CHAT_IDS;
    expect(checkAllowlist(makeMsg()).allowed).toBe(false);
  });

  test('handles multiple comma-separated IDs with whitespace', () => {
    process.env.ALLOWED_CHAT_IDS = ' alice@s.whatsapp.net , bob@s.whatsapp.net , carol@s.whatsapp.net ';
    expect(checkAllowlist(makeMsg('alice@s.whatsapp.net')).allowed).toBe(true);
    expect(checkAllowlist(makeMsg('bob@s.whatsapp.net')).allowed).toBe(true);
    expect(checkAllowlist(makeMsg('carol@s.whatsapp.net')).allowed).toBe(true);
    expect(checkAllowlist(makeMsg('dave@s.whatsapp.net')).allowed).toBe(false);
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

  test('multiple rapid messages from same chatId are batched', async () => {
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

  test('messages from different chatIds are independent', async () => {
    const msgA = makeMsg('a@s.whatsapp.net', 'alpha');
    const msgB = makeMsg('b@s.whatsapp.net', 'beta');

    const batchA = debounce(msgA);
    const batchB = debounce(msgB);

    const [resultA, resultB] = await Promise.all([batchA, batchB]);
    expect(resultA).toHaveLength(1);
    expect(resultA[0]!.text).toBe('alpha');
    expect(resultB).toHaveLength(1);
    expect(resultB[0]!.text).toBe('beta');
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
