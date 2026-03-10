import { beforeEach, describe, expect, mock, test } from 'bun:test';

const mockSendPresenceUpdate = mock(async () => undefined);

mock.module('@/whatsapp/connection', () => ({
  getSocket: () => ({ sendPresenceUpdate: mockSendPresenceUpdate }),
}));

mock.module('@/logger', () => ({
  log: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) },
}));

const { startTyping, stopTyping } = await import('@/whatsapp/presence');

beforeEach(() => {
  mockSendPresenceUpdate.mockClear();
  mockSendPresenceUpdate.mockImplementation(async () => undefined);
});

describe('presence', () => {
  test.each([
    ['composing', startTyping],
    ['paused', stopTyping],
  ] as const)('sends %s presence update', async (presenceType, fn) => {
    await fn('chat@s.whatsapp.net');
    expect(mockSendPresenceUpdate).toHaveBeenCalledTimes(1);
    expect(mockSendPresenceUpdate).toHaveBeenCalledWith(presenceType, 'chat@s.whatsapp.net');
  });

  test.each([
    ['composing', startTyping],
    ['paused', stopTyping],
  ] as const)('does not throw when %s fails', async (_presenceType, fn) => {
    mockSendPresenceUpdate.mockImplementation(async () => { throw new Error('network error'); });
    await expect(fn('chat@s.whatsapp.net')).resolves.toBeUndefined();
  });
});
