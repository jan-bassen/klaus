import { describe, expect, test, mock, beforeEach } from 'bun:test';
import type { AgentDefinition, InboundMessage, Node } from '@/types';
import type { SearchResult } from '@/db/search';

function fakeNode(partial: { id: string; title: string; body: string }): Node {
  return {
    type: 'episode',
    tags: [],
    pinned: false,
    archived: false,
    embedding: null,
    searchTsv: null,
    tokenCount: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as unknown as Node;
}

// Mock hybridSearch before importing the query
const mockHybridSearch = mock(async (): Promise<SearchResult[]> => []);
mock.module('../../db/search', () => ({ hybridSearch: mockHybridSearch }));

// Mock db for pinned nodes
const mockDb = { select: mock(() => mockDb), from: mock(() => mockDb), where: mock(async () => []) };
mock.module('../../db/client', () => ({ db: mockDb }));

// Import after mocks are set up
const { graphContextQuery } = await import('../../context/graph-context');

const dummyMsg: InboundMessage = {
  kind: 'whatsapp',
  id: 'msg-1',
  chatId: 'user@s.whatsapp.net',
  senderId: 'user@s.whatsapp.net',
  text: 'how do I reset my password?',
  timestamp: new Date(),
  messageKey: {},
};

const dummyAgent: AgentDefinition = {
  name: 'test',
  modelTier: 'default',
  tools: [],
  promptPath: '/dev/null',
};

const turn = { chatId: 'user@s.whatsapp.net', message: dummyMsg, agent: dummyAgent, flags: {} };

describe('graphContextQuery', () => {
  beforeEach(() => {
    mockHybridSearch.mockClear();
    mockDb.where.mockImplementation(async () => []);
  });

  test('name and priority are correct', () => {
    expect(graphContextQuery.name).toBe('graph_context');
    expect(graphContextQuery.priority).toBe(2);
  });

  test('truncate is always oldest', async () => {
    const result = await graphContextQuery.run(turn);
    expect(result.truncate).toBe('oldest');
  });

  test('empty DB and no search results → empty content, zero tokens', async () => {
    const result = await graphContextQuery.run(turn);
    expect(result.content).toBe('');
    expect(result.tokenCount).toBe(0);
  });

  test('search result is formatted as ### title \\n body', async () => {
    mockHybridSearch.mockImplementationOnce(async () => [
      { node: fakeNode({ id: 'n1', title: 'Password Reset', body: 'Go to settings > security.' }), score: 0.9 },
    ]);

    const result = await graphContextQuery.run(turn);
    expect(result.content).toContain('### Password Reset');
    expect(result.content).toContain('Go to settings > security.');
  });

  test('matchingChunk is used instead of node body when present', async () => {
    mockHybridSearch.mockImplementationOnce(async () => [
      { node: fakeNode({ id: 'n1', title: 'Big Doc', body: 'Full body text...' }), score: 0.8, matchingChunk: 'the relevant excerpt' },
    ]);

    const result = await graphContextQuery.run(turn);
    expect(result.content).toContain('the relevant excerpt');
    expect(result.content).not.toContain('Full body text...');
  });

  test('multiple results are joined with double newline', async () => {
    mockHybridSearch.mockImplementationOnce(async () => [
      { node: fakeNode({ id: 'n1', title: 'Alpha', body: 'alpha body' }), score: 0.9 },
      { node: fakeNode({ id: 'n2', title: 'Beta', body: 'beta body' }), score: 0.7 },
    ]);

    const result = await graphContextQuery.run(turn);
    const blocks = result.content.split('\n\n');
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(result.content).toContain('### Alpha');
    expect(result.content).toContain('### Beta');
  });

  test('tokenCount is non-zero when content present', async () => {
    mockHybridSearch.mockImplementationOnce(async () => [
      { node: fakeNode({ id: 'n1', title: 'X', body: 'some content here' }), score: 0.8 },
    ]);

    const result = await graphContextQuery.run(turn);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  test('no text in message → skips search, only pinned nodes included', async () => {
    const { text: _unused, ...msgWithoutText } = dummyMsg;
    const noTextTurn = { ...turn, message: msgWithoutText as InboundMessage };
    await graphContextQuery.run(noTextTurn);
    expect(mockHybridSearch).not.toHaveBeenCalled();
  });
});
