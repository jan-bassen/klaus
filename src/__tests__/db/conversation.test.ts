import { expect, test } from 'bun:test';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { conversationQuery } from '@/context/conversation';
import { describeDb, setupTestDb } from './helpers';
import { config } from '@/config';
import type { AgentDefinition, InboundMessage } from '@/types';

setupTestDb();

const CHAT_ID = 'user@s.whatsapp.net';
const OTHER_CHAT_ID = 'other@s.whatsapp.net';

const dummyMsg: InboundMessage = {
  kind: 'whatsapp',
  id: 'msg-1',
  chatId: CHAT_ID,
  senderId: CHAT_ID,
  text: 'hi',
  timestamp: new Date(),
  messageKey: {},
};

const dummyAgent: AgentDefinition = {
  name: 'test',
  modelTier: 'default',
  tools: [],
  promptPath: '/dev/null',
};

const turn = { msg: dummyMsg, agent: dummyAgent, flags: {} };

async function insertMessage(
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  opts?: { createdAt?: Date },
) {
  const [row] = await db
    .insert(messages)
    .values({
      chatId: chatId,
      role,
      content,
      createdAt: opts?.createdAt ?? new Date(),
    })
    .returning();
  return row!;
}

describeDb('conversationQuery', () => {
  test('empty DB → empty content, zero tokens, truncate oldest', async () => {
    const result = await conversationQuery.run(turn);
    expect(result.content).toBe('');
    expect(result.tokenCount).toBe(0);
    expect(result.truncate).toBe('oldest');
  });

  test('single user message formatted as "User: <content>"', async () => {
    await insertMessage(CHAT_ID, 'user', 'hello there');
    const result = await conversationQuery.run(turn);
    expect(result.content).toBe('User: hello there');
  });

  test('single assistant message formatted as "<agent>: <content>"', async () => {
    await insertMessage(CHAT_ID, 'assistant', 'how can I help?');
    const result = await conversationQuery.run(turn);
    expect(result.content).toBe(`${dummyAgent.name}: how can I help?`);
  });

  test('user+assistant pair is in chronological order separated by double newline', async () => {
    const t0 = new Date('2024-01-01T10:00:00Z');
    const t1 = new Date('2024-01-01T10:01:00Z');
    await insertMessage(CHAT_ID, 'user', 'hi', { createdAt: t0 });
    await insertMessage(CHAT_ID, 'assistant', 'hello!', { createdAt: t1 });

    const result = await conversationQuery.run(turn);
    expect(result.content).toBe(`User: hi\n\n${dummyAgent.name}: hello!`);
  });

  test('three messages appear in chronological order', async () => {
    const t0 = new Date('2024-01-01T10:00:00Z');
    const t1 = new Date('2024-01-01T10:01:00Z');
    const t2 = new Date('2024-01-01T10:02:00Z');
    await insertMessage(CHAT_ID, 'user', 'first', { createdAt: t0 });
    await insertMessage(CHAT_ID, 'assistant', 'second', { createdAt: t1 });
    await insertMessage(CHAT_ID, 'user', 'third', { createdAt: t2 });

    const result = await conversationQuery.run(turn);
    const lines = result.content.split('\n\n');
    expect(lines[0]).toBe('User: first');
    expect(lines[1]).toBe(`${dummyAgent.name}: second`);
    expect(lines[2]).toBe('User: third');
  });

  test('messages from other chatIds are excluded', async () => {
    await insertMessage(CHAT_ID, 'user', 'mine');
    await insertMessage(OTHER_CHAT_ID, 'user', 'not mine');

    const result = await conversationQuery.run(turn);
    expect(result.content).toBe('User: mine');
  });

  test('messages with null content are skipped', async () => {
    const t0 = new Date('2024-01-01T10:00:00Z');
    const t1 = new Date('2024-01-01T10:01:00Z');
    // Insert a message with null content (tool-call-only assistant turn)
    await db.insert(messages).values({
      chatId: CHAT_ID,
      role: 'assistant',
      content: null,
      createdAt: t0,
    });
    await insertMessage(CHAT_ID, 'user', 'visible', { createdAt: t1 });

    const result = await conversationQuery.run(turn);
    expect(result.content).toBe('User: visible');
  });

  test('tokenCount uses char/4 estimate', async () => {
    const content = 'hello'; // 5 chars → Math.ceil(5/4) = 2 tokens
    await insertMessage(CHAT_ID, 'user', content);
    const result = await conversationQuery.run(turn);
    expect(result.tokenCount).toBe(Math.ceil(content.length / 4));
  });

  test('token budget stops including oldest messages when exceeded', async () => {
    // Each message = 40% of budget in tokens → 2 fit (80%), 3 don't (120%)
    const budget = config.context.conversationTokens;
    const tokensPerMsg = Math.ceil(budget * 2 / 5);
    const charsPerMsg = tokensPerMsg * 4;
    const pad = (label: string) => label + 'x'.repeat(charsPerMsg - label.length);
    const t0 = new Date('2024-01-01T10:00:00Z');
    const t1 = new Date('2024-01-01T10:01:00Z');
    const t2 = new Date('2024-01-01T10:02:00Z');
    await insertMessage(CHAT_ID, 'user', pad('oldest message'), { createdAt: t0 });
    await insertMessage(CHAT_ID, 'assistant', pad('middle message'), { createdAt: t1 });
    await insertMessage(CHAT_ID, 'user', pad('newest message'), { createdAt: t2 });

    const result = await conversationQuery.run(turn);
    expect(result.content).not.toContain('oldest message');
    expect(result.content).toContain('middle message');
    expect(result.content).toContain('newest message');
    expect(result.tokenCount).toBe(2 * tokensPerMsg);
  });

  test('name and priority are correct', () => {
    expect(conversationQuery.name).toBe('conversation');
    expect(conversationQuery.priority).toBe(3);
  });
});
