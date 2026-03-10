import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { InboundMessage } from '@/types';

const mockEnqueueMessage = mock((_opts: unknown) => undefined);
mock.module('@/whatsapp/send', () => ({ enqueueMessage: mockEnqueueMessage }));

const mockActiveTasks = mock(async (_params: unknown) => [] as unknown[]);
mock.module('@/db/queries', () => ({
  QUERIES: { active_tasks: mockActiveTasks },
}));

import { tasksCommand } from '@/commands/tasks';

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
});

describe('/tasks', () => {
  test('sends "No active tasks." when list is empty', async () => {
    const msg = makeMsg();
    await tasksCommand.execute(msg, []);

    const { content } = (mockEnqueueMessage.mock.calls[0] as [{ content: string }])[0];
    expect(content).toBe('No active tasks.');
  });

  test('formats task list with count in header', async () => {
    mockActiveTasks.mockResolvedValue([
      { id: '1', assignedTo: 'memorize', objective: 'Remember meeting notes', createdAt: new Date('2026-01-01T14:02:00Z') },
      { id: '2', assignedTo: 'thinking', objective: 'Research quantum computing', createdAt: new Date('2026-01-01T09:45:00Z') },
    ]);

    const msg = makeMsg();
    await tasksCommand.execute(msg, []);

    const { content } = (mockEnqueueMessage.mock.calls[0] as [{ content: string }])[0];
    expect(content).toMatch(/active tasks/i);
    expect(content).toContain('2');
    expect(content).toContain('memorize');
    expect(content).toContain('Remember meeting notes');
    expect(content).toContain('thinking');
    expect(content).toContain('Research quantum computing');
  });

  test('falls back to "unknown" when assignedTo is null', async () => {
    mockActiveTasks.mockResolvedValue([
      { id: '1', assignedTo: null, objective: 'Some task', createdAt: new Date() },
    ]);

    const msg = makeMsg();
    await tasksCommand.execute(msg, []);

    const { content } = (mockEnqueueMessage.mock.calls[0] as [{ content: string }])[0];
    expect(content).toContain('unknown');
  });

  test('scopes query to message chatId', async () => {
    const msg = makeMsg('specific@s.whatsapp.net');
    await tasksCommand.execute(msg, []);

    expect(mockActiveTasks).toHaveBeenCalledWith({ chatId: 'specific@s.whatsapp.net' });
  });

  test('sends error fallback when DB throws', async () => {
    mockActiveTasks.mockRejectedValue(new Error('DB down'));

    const msg = makeMsg();
    await tasksCommand.execute(msg, []);

    const { content } = (mockEnqueueMessage.mock.calls[0] as [{ content: string }])[0];
    expect(content).toContain('database error');
  });
});
