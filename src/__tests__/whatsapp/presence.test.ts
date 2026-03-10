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

describe('startTyping', () => {
  test('sends composing presence update', async () => {
    await startTyping('chat@s.whatsapp.net');
    expect(mockSendPresenceUpdate).toHaveBeenCalledTimes(1);
    expect(mockSendPresenceUpdate).toHaveBeenCalledWith('composing', 'chat@s.whatsapp.net');
  });

  test('does not throw when sendPresenceUpdate fails', async () => {
    mockSendPresenceUpdate.mockImplementation(async () => { throw new Error('network error'); });
    await expect(startTyping('chat@s.whatsapp.net')).resolves.toBeUndefined();
  });
});

describe('stopTyping', () => {
  test('sends paused presence update', async () => {
    await stopTyping('chat@s.whatsapp.net');
    expect(mockSendPresenceUpdate).toHaveBeenCalledTimes(1);
    expect(mockSendPresenceUpdate).toHaveBeenCalledWith('paused', 'chat@s.whatsapp.net');
  });

  test('does not throw when sendPresenceUpdate fails', async () => {
    mockSendPresenceUpdate.mockImplementation(async () => { throw new Error('network error'); });
    await expect(stopTyping('chat@s.whatsapp.net')).resolves.toBeUndefined();
  });
});
