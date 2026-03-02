import { describe, expect, test } from 'bun:test';
import { normalizeMessage } from '@/whatsapp/receive';

function makeRaw(overrides: Record<string, unknown> = {}): unknown {
  return {
    key: {
      remoteJid: 'user@s.whatsapp.net',
      fromMe: false,
      id: 'ABC123',
      participant: undefined,
    },
    message: {
      conversation: 'Hello Klaus!',
    },
    messageTimestamp: 1_700_000_000,
    ...overrides,
  };
}

describe('normalizeMessage', () => {
  test('returns InboundMessage for a simple text message', () => {
    const result = normalizeMessage(makeRaw());
    expect(result).not.toBeNull();
    expect(result!.text).toBe('Hello Klaus!');
    expect(result!.chatId).toBe('user@s.whatsapp.net');
  });

  test('skips messages sent by us (fromMe = true)', () => {
    const result = normalizeMessage(makeRaw({ key: { remoteJid: 'user@s.whatsapp.net', fromMe: true, id: 'X' } }));
    expect(result).toBeNull();
  });

  test('skips messages without a remoteJid', () => {
    const result = normalizeMessage(makeRaw({ key: { remoteJid: undefined, fromMe: false, id: 'X' } }));
    expect(result).toBeNull();
  });

  test('skips messages without a message field', () => {
    const result = normalizeMessage(makeRaw({ message: undefined }));
    expect(result).toBeNull();
  });

  test('skips non-text messages (e.g. image only)', () => {
    const result = normalizeMessage(makeRaw({ message: { imageMessage: { url: 'https://example.com/img.jpg' } } }));
    expect(result).toBeNull();
  });

  test('extracts text from extendedTextMessage', () => {
    const result = normalizeMessage(makeRaw({
      message: { extendedTextMessage: { text: 'Quoted reply text' } },
    }));
    expect(result).not.toBeNull();
    expect(result!.text).toBe('Quoted reply text');
  });

  test('converts messageTimestamp (seconds) to a Date', () => {
    const result = normalizeMessage(makeRaw({ messageTimestamp: 1_700_000_000 }));
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBeInstanceOf(Date);
    expect(result!.timestamp.getTime()).toBe(1_700_000_000 * 1000);
  });

  test('handles bigint messageTimestamp', () => {
    const result = normalizeMessage(makeRaw({ messageTimestamp: BigInt(1_700_000_000) }));
    expect(result).not.toBeNull();
    expect(result!.timestamp.getTime()).toBe(1_700_000_000 * 1000);
  });

  test('uses key.id as the message id', () => {
    const result = normalizeMessage(makeRaw());
    expect(result!.id).toBe('ABC123');
  });

  test('falls back to crypto.randomUUID when key.id is missing', () => {
    const result = normalizeMessage(makeRaw({ key: { remoteJid: 'user@s.whatsapp.net', fromMe: false, id: undefined } }));
    expect(result).not.toBeNull();
    expect(result!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('uses participant as senderId in group messages', () => {
    const result = normalizeMessage(makeRaw({
      key: { remoteJid: 'group@g.us', fromMe: false, id: 'X', participant: 'member@s.whatsapp.net' },
    }));
    expect(result!.senderId).toBe('member@s.whatsapp.net');
  });

  test('falls back to remoteJid as senderId in 1:1 messages', () => {
    const result = normalizeMessage(makeRaw());
    expect(result!.senderId).toBe('user@s.whatsapp.net');
  });
});
