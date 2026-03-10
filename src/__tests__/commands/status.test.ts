import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { InboundMessage } from '@/types';

const mockEnqueueMessage = mock((_opts: unknown) => undefined);
mock.module('@/whatsapp/send', () => ({ enqueueMessage: mockEnqueueMessage }));

const mockActiveTasks = mock(async (_params: unknown) => [] as unknown[]);
const mockNodeCount = mock(async (_params: unknown) => ({ count: 0 }));
mock.module('@/db/queries', () => ({
  QUERIES: {
    active_tasks: mockActiveTasks,
    node_count: mockNodeCount,
  },
}));

import { statusCommand } from '@/commands/status';
import { setDefaultAgent, _resetDefaultsForTest } from '@/core/defaults';
import { config } from '@/config';

function makeMsg(chatId = 'user@s.whatsapp.net'): InboundMessage {
  return {
    kind: 'whatsapp',
    id: crypto.randomUUID(),
    chatId,
    senderId: chatId,
    timestamp: new Date(),
    messageKey: {},
  };
}

beforeEach(() => {
  mockEnqueueMessage.mockClear();
  mockActiveTasks.mockClear();
  mockNodeCount.mockClear();
  _resetDefaultsForTest();
});

afterEach(() => {
  _resetDefaultsForTest();
});

describe('/status', () => {
  test('sends formatted status with correct structure', async () => {
    mockActiveTasks.mockResolvedValue([{ id: '1' }, { id: '2' }]);
    mockNodeCount.mockResolvedValue({ count: 42 });

    const msg = makeMsg();
    await statusCommand.execute(msg, []);

    expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
    const { content } = (mockEnqueueMessage.mock.calls[0] as [{ content: string }])[0];
    expect(content).toContain(`@${config.defaultAgent}`);
    expect(content).toContain('2');
    expect(content).toMatch(/active/i);
    expect(content).toContain('42');
    expect(content).toMatch(/nodes/i);
  });

  test('uses getDefaultAgent override when set', async () => {
    const msg = makeMsg();
    setDefaultAgent(msg.chatId, 'thinking');
    await statusCommand.execute(msg, []);

    const { content } = (mockEnqueueMessage.mock.calls[0] as [{ content: string }])[0];
    expect(content).toContain('@thinking');
  });

  test('scopes active_tasks query to the message chatId', async () => {
    const msg = makeMsg('specific@s.whatsapp.net');
    await statusCommand.execute(msg, []);

    expect(mockActiveTasks).toHaveBeenCalledWith({ chatId: 'specific@s.whatsapp.net' });
  });

  test('sends error fallback when DB throws', async () => {
    mockActiveTasks.mockRejectedValue(new Error('DB down'));

    const msg = makeMsg();
    await statusCommand.execute(msg, []);

    const { content } = (mockEnqueueMessage.mock.calls[0] as [{ content: string }])[0];
    expect(content).toContain('database error');
  });

});
