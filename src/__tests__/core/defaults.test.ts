import { afterEach, describe, expect, test } from 'bun:test';
import { getDefaultAgent, setDefaultAgent, _resetDefaultsForTest } from '@/core/defaults';
import { config } from '@/config';

afterEach(() => {
  _resetDefaultsForTest();
});

describe('getDefaultAgent', () => {
  test('returns config.defaultAgent when no override is set', () => {
    expect(getDefaultAgent('user@s.whatsapp.net')).toBe(config.defaultAgent);
  });

  test('returns the override after setDefaultAgent is called', () => {
    setDefaultAgent('user@s.whatsapp.net', 'thinking');
    expect(getDefaultAgent('user@s.whatsapp.net')).toBe('thinking');
  });

  test('overrides are per-chatId (different chatIds are independent)', () => {
    setDefaultAgent('chat-a', 'thinking');
    expect(getDefaultAgent('chat-b')).toBe(config.defaultAgent);
  });
});

describe('setDefaultAgent', () => {
  test('null resets to config.defaultAgent', () => {
    setDefaultAgent('user@s.whatsapp.net', 'thinking');
    setDefaultAgent('user@s.whatsapp.net', null);
    expect(getDefaultAgent('user@s.whatsapp.net')).toBe(config.defaultAgent);
  });
});
