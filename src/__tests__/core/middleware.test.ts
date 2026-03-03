import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { checkAllowlist } from '@/core/middleware';
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

