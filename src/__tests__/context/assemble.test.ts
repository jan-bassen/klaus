import { describe, expect, test } from 'bun:test';
import { assembleContext } from '@/context/assemble';
import type { AgentDefinition, ContextQuery, InboundMessage } from '@/types';

// ─── fixtures ────────────────────────────────────────────────────────────────

const dummyMsg: InboundMessage = {
  kind: 'whatsapp',
  id: 'msg-1',
  chatId: 'user@s.whatsapp.net',
  senderId: 'user@s.whatsapp.net',
  text: 'hello',
  timestamp: new Date(),
  messageKey: {},
};

const dummyAgent: AgentDefinition = {
  name: 'test',
  modelTier: 'default',
  tools: [],
  promptPath: '/dev/null',
};

function makeQuery(
  name: string,
  priority: number,
  content: string,
  tokenCount: number,
  truncate: 'never' | 'always' | 'oldest' | 'summarize' = 'never',
): ContextQuery {
  return {
    name,
    priority,
    run: async () => ({ content, tokenCount, truncate }),
  };
}

// config.context.totalTokens = 100_000 — use tokenCount values relative to that

describe('assembleContext', () => {
  // ─── basic shape ─────────────────────────────────────────────────────────

  test('no queries → all fields empty, totalTokens 0', async () => {
    const result = await assembleContext(dummyMsg, dummyAgent);
    expect(result.conversation).toBe('');
    expect(result.graphContext).toBe('');
    expect(result.activeTasks).toBe('');
    expect(result.toolDescriptions).toBe('');
    expect(result.flagInjections).toBe('');
    expect(result.totalTokens).toBe(0);
  });

  test('maps flag_injections → flagInjections', async () => {
    const q = makeQuery('flag_injections', 0, 'be concise', 10, 'never');
    const result = await assembleContext(dummyMsg, dummyAgent, [q]);
    expect(result.flagInjections).toBe('be concise');
  });

  test('maps conversation → conversation', async () => {
    const q = makeQuery('conversation', 3, 'User: hi\n\nKlaus: hello', 20, 'oldest');
    const result = await assembleContext(dummyMsg, dummyAgent, [q]);
    expect(result.conversation).toBe('User: hi\n\nKlaus: hello');
  });

  test('maps all five known query names', async () => {
    const queries = [
      makeQuery('flag_injections', 0, 'flags', 5, 'never'),
      makeQuery('tool_descriptions', 1, 'tools', 5, 'never'),
      makeQuery('graph_context', 2, 'graph', 5, 'always'),
      makeQuery('conversation', 3, 'convo', 5, 'oldest'),
      makeQuery('active_tasks', 4, 'tasks', 5, 'always'),
    ];
    const result = await assembleContext(dummyMsg, dummyAgent, queries);
    expect(result.flagInjections).toBe('flags');
    expect(result.toolDescriptions).toBe('tools');
    expect(result.graphContext).toBe('graph');
    expect(result.conversation).toBe('convo');
    expect(result.activeTasks).toBe('tasks');
  });

  test('unknown query name is silently ignored', async () => {
    const q = makeQuery('unknown_thing', 2, 'whatever', 5, 'always');
    const result = await assembleContext(dummyMsg, dummyAgent, [q]);
    expect(result.totalTokens).toBe(5); // counted in budget
    expect(result.conversation).toBe(''); // but not mapped to any field
  });

  test('sums tokenCount across all queries', async () => {
    const queries = [
      makeQuery('conversation', 3, 'a', 300, 'oldest'),
      makeQuery('flag_injections', 0, 'b', 700, 'never'),
    ];
    const result = await assembleContext(dummyMsg, dummyAgent, queries);
    expect(result.totalTokens).toBe(1000);
  });

  test('failed query is skipped, others continue', async () => {
    const bad: ContextQuery = {
      name: 'conversation',
      priority: 3,
      run: async () => { throw new Error('DB exploded'); },
    };
    const good = makeQuery('flag_injections', 0, 'flags', 5, 'never');
    const result = await assembleContext(dummyMsg, dummyAgent, [bad, good]);
    expect(result.flagInjections).toBe('flags');
    expect(result.conversation).toBe(''); // failed, stays empty
  });

  // ─── !flags from msg.text ────────────────────────────────────────────────

  test('!flags in msg.text are parsed and passed to flagsQuery via turn.flags', async () => {
    // flagsQuery reads turn.flags built by assembleContext from parseFlags(msg)
    // Using a spy query to verify turn.flags is correctly set
    let capturedFlags: Record<string, boolean> | undefined;
    const spyQuery: ContextQuery = {
      name: 'flag_injections',
      priority: 0,
      run: async (turn) => {
        capturedFlags = turn.flags;
        return { content: '', tokenCount: 0, truncate: 'never' };
      },
    };
    const msgWithFlag: InboundMessage = { ...dummyMsg, text: '!verbose do this' };
    await assembleContext(msgWithFlag, dummyAgent, [spyQuery]);
    expect(capturedFlags).toEqual({ verbose: true });
  });

  // ─── trimming: always ─────────────────────────────────────────────────────

  test('under budget → no trimming', async () => {
    // 50_000 + 40_000 = 90_000 < 100_000 → no trim
    const queries = [
      makeQuery('graph_context', 2, 'graph content', 50_000, 'always'),
      makeQuery('flag_injections', 0, 'flags', 40_000, 'never'),
    ];
    const result = await assembleContext(dummyMsg, dummyAgent, queries);
    expect(result.graphContext).toBe('graph content');
    expect(result.flagInjections).toBe('flags');
    expect(result.totalTokens).toBe(90_000);
  });

  test('over budget: always-truncate query is cleared (priority 2 trimmed before priority 3)', async () => {
    // 60_000 + 60_000 = 120_000 > 100_000 → excess 20_000
    // graph_context (priority 2, always) is trimmed before conversation (priority 3, oldest)
    // Lower priority number = trimmed first
    const queries = [
      makeQuery('graph_context', 2, 'graph content', 60_000, 'always'),
      makeQuery('conversation', 3, 'Turn 1\n\nTurn 2', 60_000, 'oldest'),
    ];
    const result = await assembleContext(dummyMsg, dummyAgent, queries);
    expect(result.graphContext).toBe('');
    expect(result.conversation).toBe('Turn 1\n\nTurn 2'); // untouched
    expect(result.totalTokens).toBe(60_000);
  });

  test('over budget: never-truncate is protected even with lowest priority number', async () => {
    // flags (priority 0, never) cannot be trimmed even though it has the lowest priority number
    // graph_context (priority 2, always) is trimmed instead
    const queries = [
      makeQuery('flag_injections', 0, 'important flags', 60_000, 'never'),
      makeQuery('graph_context', 2, 'less important graph', 60_000, 'always'),
    ];
    const result = await assembleContext(dummyMsg, dummyAgent, queries);
    expect(result.flagInjections).toBe('important flags'); // protected
    expect(result.graphContext).toBe(''); // cleared
  });

  // ─── trimming: oldest ────────────────────────────────────────────────────

  test('over budget: oldest-truncate removes blocks from front', async () => {
    // Excess = 3 tokens (just enough to remove the first block)
    // Each block is ~9 chars → Math.ceil((9+2)/4) = 3 tokens
    const queries = [
      makeQuery('conversation', 3, 'Block 1\n\nBlock 2\n\nBlock 3', 100_003, 'oldest'),
    ];
    const result = await assembleContext(dummyMsg, dummyAgent, queries);
    // First block removed to cover excess of 3
    expect(result.conversation).not.toContain('Block 1');
    expect(result.conversation).toContain('Block 2');
    expect(result.conversation).toContain('Block 3');
  });

  test('over budget: oldest clears content if all blocks must be removed', async () => {
    // 60_000 + 60_000 = 120_000 > 100_000 → excess 20_000
    // Only conversation (oldest) is trimmable; it gets drained entirely
    const queries = [
      makeQuery('flag_injections', 0, 'protected', 60_000, 'never'),
      makeQuery('conversation', 3, 'Turn 1\n\nTurn 2', 60_000, 'oldest'),
    ];
    const result = await assembleContext(dummyMsg, dummyAgent, queries);
    // All blocks removed (each block is tiny vs the 20k excess)
    expect(result.conversation).toBe('');
  });

  // ─── totalTokens reflects post-trim state ────────────────────────────────

  test('totalTokens reflects post-trim state', async () => {
    const queries = [
      makeQuery('graph_context', 2, 'stuff', 80_000, 'always'),
      makeQuery('flag_injections', 0, 'flags', 40_000, 'never'),
    ];
    // Pre-trim total: 120_000. graph_context (priority 2, always) cleared → 40_000.
    const result = await assembleContext(dummyMsg, dummyAgent, queries);
    expect(result.totalTokens).toBe(40_000);
  });
});
