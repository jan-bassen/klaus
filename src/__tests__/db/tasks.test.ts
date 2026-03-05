import { expect, test } from 'bun:test';
import { db } from '@/db/client';
import { tasks } from '@/db/schema';
import { activeTasksQuery } from '@/context/tasks';
import { describeDb, setupTestDb } from './helpers';
import type { AgentDefinition, InboundMessage } from '@/types';

setupTestDb();

const CHAT_ID = 'user@s.whatsapp.net';

const dummyMsg: InboundMessage = {
  kind: 'whatsapp',
  id: 'msg-1',
  chatId: CHAT_ID,
  senderId: CHAT_ID,
  text: 'what tasks are running?',
  timestamp: new Date(),
  messageKey: {},
};

const dummyAgent: AgentDefinition = {
  name: 'test',
  modelTier: 'default',
  tools: [],
  promptPath: '/dev/null',
};

const turn = { chatId: CHAT_ID, message: dummyMsg, agent: dummyAgent, flags: {} };

describeDb('activeTasksQuery', () => {
  test('name and priority are correct', () => {
    expect(activeTasksQuery.name).toBe('active_tasks');
    expect(activeTasksQuery.priority).toBe(4);
  });

  test('empty DB → empty content, zero tokens, truncate always', async () => {
    const result = await activeTasksQuery.run(turn);
    expect(result.content).toBe('');
    expect(result.tokenCount).toBe(0);
    expect(result.truncate).toBe('always');
  });

  test('truncate is always "always"', async () => {
    const result = await activeTasksQuery.run(turn);
    expect(result.truncate).toBe('always');
  });

  test('pending task appears in output', async () => {
    await db.insert(tasks).values({ chatId: CHAT_ID, objective: 'Send weekly report', status: 'pending' });
    const result = await activeTasksQuery.run(turn);
    expect(result.content).toContain('[pending] Send weekly report');
  });

  test('running task appears in output', async () => {
    await db.insert(tasks).values({ chatId: CHAT_ID, objective: 'Analyze data', status: 'running' });
    const result = await activeTasksQuery.run(turn);
    expect(result.content).toContain('[running] Analyze data');
  });

  test('done and failed tasks are excluded', async () => {
    await db.insert(tasks).values({ chatId: CHAT_ID, objective: 'Finished task', status: 'done' });
    await db.insert(tasks).values({ chatId: CHAT_ID, objective: 'Broken task', status: 'failed' });
    const result = await activeTasksQuery.run(turn);
    expect(result.content).toBe('');
    expect(result.tokenCount).toBe(0);
  });

  test('multiple active tasks are each on their own line', async () => {
    await db.insert(tasks).values({ chatId: CHAT_ID, objective: 'Task A', status: 'pending' });
    await db.insert(tasks).values({ chatId: CHAT_ID, objective: 'Task B', status: 'running' });
    const result = await activeTasksQuery.run(turn);
    const lines = result.content.split('\n');
    expect(lines.length).toBe(2);
    expect(lines.some((l) => l.includes('Task A'))).toBe(true);
    expect(lines.some((l) => l.includes('Task B'))).toBe(true);
  });

  test('tokenCount is non-zero when tasks are present', async () => {
    await db.insert(tasks).values({ chatId: CHAT_ID, objective: 'Some work', status: 'pending' });
    const result = await activeTasksQuery.run(turn);
    expect(result.tokenCount).toBeGreaterThan(0);
  });
});
