import { describe, expect, test } from 'bun:test';
import { FLAG_MAP, parseFlags, stripFlags } from '@/whatsapp/flags';
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
    expect(parseFlags(makeMsg('!verbose tell me more'))).toEqual({
      verbose: true,
    });
  });

  test('parses a single known flag at the end', () => {
    expect(parseFlags(makeMsg('explain this !concise'))).toEqual({
      concise: true,
    });
  });

  test('parses a flag mid-sentence', () => {
    expect(parseFlags(makeMsg('please !raw give me the data'))).toEqual({
      raw: true,
    });
  });

  test('parses multiple known flags', () => {
    expect(parseFlags(makeMsg('!verbose !debug explain'))).toEqual({
      verbose: true,
      debug: true,
    });
  });

  test('ignores unknown flags', () => {
    expect(parseFlags(makeMsg('!banana explain'))).toEqual({});
  });

  test('returns only known flags when mixed with unknown', () => {
    expect(parseFlags(makeMsg('!verbose !banana !debug'))).toEqual({
      verbose: true,
      debug: true,
    });
  });

  test('handles duplicate flags idempotently', () => {
    expect(parseFlags(makeMsg('!verbose !verbose'))).toEqual({
      verbose: true,
    });
  });

  test('is case-sensitive — uppercase flags are not recognized', () => {
    expect(parseFlags(makeMsg('!Verbose !DEBUG'))).toEqual({});
  });

  test('does not match a bare ! with no name', () => {
    expect(parseFlags(makeMsg('hey ! what'))).toEqual({});
  });

  test('parses all four built-in flags', () => {
    expect(
      parseFlags(makeMsg('!verbose !concise !debug !raw')),
    ).toEqual({
      verbose: true,
      concise: true,
      debug: true,
      raw: true,
    });
  });
});

describe('stripFlags', () => {
  test('removes a recognized flag and trims', () => {
    expect(stripFlags('!verbose tell me more')).toBe('tell me more');
  });

  test('removes multiple recognized flags', () => {
    expect(stripFlags('!verbose !debug explain this')).toBe('explain this');
  });

  test('leaves unknown !words intact', () => {
    expect(stripFlags('!banana explain')).toBe('!banana explain');
  });

  test('removes only recognized flags among mixed tokens', () => {
    expect(stripFlags('!verbose !banana !raw data')).toBe('!banana data');
  });

  test('collapses extra whitespace', () => {
    expect(stripFlags('  !verbose   tell   me  ')).toBe('tell me');
  });

  test('returns empty string when only flags remain', () => {
    expect(stripFlags('!verbose !concise')).toBe('');
  });

  test('returns the text unchanged when no flags present', () => {
    expect(stripFlags('just a normal message')).toBe('just a normal message');
  });

  test('leaves bare ! intact', () => {
    expect(stripFlags('hey ! what')).toBe('hey ! what');
  });
});

describe('FLAG_MAP', () => {
  test('contains exactly 4 flags', () => {
    expect(Object.keys(FLAG_MAP)).toHaveLength(4);
  });

  test('every flag has a non-empty promptInjection', () => {
    for (const flag of Object.values(FLAG_MAP)) {
      expect(flag.promptInjection.length).toBeGreaterThan(0);
    }
  });
});
