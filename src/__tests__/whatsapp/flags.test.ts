import { describe, expect, test } from 'bun:test';
import { parseFlags, stripFlags } from '@/whatsapp/flags';
import { getKnownFlags } from '@/context/flags';
import type { InboundMessage } from '@/types';

function makeMsg(text?: string): InboundMessage {
  const base = {
    kind: 'whatsapp' as const,
    id: crypto.randomUUID(),
    chatId: 'user@s.whatsapp.net',
    senderId: 'user@s.whatsapp.net',
    timestamp: new Date(),
    messageKey: {},
  };
  if (text !== undefined) return { ...base, text };
  return base;
}

// Derive flag names from context/flags so tests never break when flags are added/removed
const knownFlags = getKnownFlags();
const flagA = knownFlags[0]!;
const flagB = knownFlags[1] ?? knownFlags[0]!; // same as flagA when only one flag exists

describe('parseFlags', () => {
  test('returns {} when text is undefined', () => {
    expect(parseFlags(makeMsg(undefined))).toEqual({});
  });

  test('returns {} when text is empty', () => {
    expect(parseFlags(makeMsg(''))).toEqual({});
  });

  test('returns {} when no flags in text', () => {
    expect(parseFlags(makeMsg('just a normal message'))).toEqual({});
  });

  test('parses a single known flag at the start', () => {
    expect(parseFlags(makeMsg(`!${flagA} tell me more`))).toEqual({ [flagA]: true });
  });

  test('parses a single known flag at the end', () => {
    expect(parseFlags(makeMsg(`explain this !${flagA}`))).toEqual({ [flagA]: true });
  });

  test('parses a flag mid-sentence', () => {
    expect(parseFlags(makeMsg(`please !${flagA} give me the data`))).toEqual({ [flagA]: true });
  });

  test('parses multiple known flags', () => {
    const text = `!${flagA} !${flagB} explain`;
    const expected = { [flagA]: true, [flagB]: true };
    expect(parseFlags(makeMsg(text))).toEqual(expected);
  });

  test('ignores unknown flags', () => {
    expect(parseFlags(makeMsg('!banana explain'))).toEqual({});
  });

  test('returns only known flags when mixed with unknown', () => {
    expect(parseFlags(makeMsg(`!${flagA} !banana`))).toEqual({ [flagA]: true });
  });

  test('handles duplicate flags idempotently', () => {
    expect(parseFlags(makeMsg(`!${flagA} !${flagA}`))).toEqual({ [flagA]: true });
  });

  test('is case-sensitive — uppercase flags are not recognized', () => {
    const upper = flagA.charAt(0).toUpperCase() + flagA.slice(1);
    expect(parseFlags(makeMsg(`!${upper}`))).toEqual({});
  });

  test('does not match a bare ! with no name', () => {
    expect(parseFlags(makeMsg('hey ! what'))).toEqual({});
  });

  test('parses all flags defined in config', () => {
    const text = knownFlags.map((f) => `!${f}`).join(' ');
    const expected = Object.fromEntries(knownFlags.map((f) => [f, true]));
    expect(parseFlags(makeMsg(text))).toEqual(expected);
  });
});

describe('stripFlags', () => {
  test('removes a recognized flag and trims', () => {
    expect(stripFlags(`!${flagA} tell me more`)).toBe('tell me more');
  });

  test('removes multiple recognized flags', () => {
    expect(stripFlags(`!${flagA} !${flagB} explain this`)).toBe('explain this');
  });

  test('leaves unknown !words intact', () => {
    expect(stripFlags('!banana explain')).toBe('!banana explain');
  });

  test('removes only recognized flags among mixed tokens', () => {
    expect(stripFlags(`!${flagA} !banana data`)).toBe('!banana data');
  });

  test('collapses extra whitespace', () => {
    expect(stripFlags(`  !${flagA}   tell   me  `)).toBe('tell me');
  });

  test('returns empty string when only flags remain', () => {
    expect(stripFlags(`!${flagA} !${flagB}`)).toBe('');
  });

  test('returns the text unchanged when no flags present', () => {
    expect(stripFlags('just a normal message')).toBe('just a normal message');
  });

  test('leaves bare ! intact', () => {
    expect(stripFlags('hey ! what')).toBe('hey ! what');
  });
});
