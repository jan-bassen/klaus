import { describe, expect, test } from 'bun:test';
import { assembleContext } from '@/core/assemble';
import { flagsQuery } from '@/context/flags';
import { snippetsQuery } from '@/context/snippets';
import type { AgentDefinition, ContextQuery, TurnContext } from '@/types';

// ─── fixtures ────────────────────────────────────────────────────────────────

const CHAT_ID = 'user@s.whatsapp.net';

const dummyAgent: AgentDefinition = {
  name: 'test',
  modelTier: 'default',
  tools: [],
  promptPath: '/dev/null',
};

function makeTurn(
  overrides: Partial<Omit<TurnContext, 'assembled'>> = {},
): Omit<TurnContext, 'assembled'> {
  return {
    chatId: CHAT_ID,
    message: {
      kind: 'whatsapp',
      id: 'msg-1',
      chatId: CHAT_ID,
      senderId: CHAT_ID,
      text: 'hello',
      timestamp: new Date(),
      messageKey: {},
    },
    agent: dummyAgent,
    flags: {},
    ...overrides,
  };
}

function makeQuery(
  name: string,
  priority: number,
  content: string,
  tokenCount: number,
  truncate: 'never' | 'always' | 'oldest' = 'never',
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

  test('no queries → vars is empty, totalTokens 0', async () => {
    const result = await assembleContext(makeTurn(), []);
    expect(result.vars).toEqual({});
    expect(result.totalTokens).toBe(0);
  });

  test('snippetsQuery → extraVars land as named template vars', async () => {
    const result = await assembleContext(makeTurn(), [snippetsQuery]);
    expect(result.vars['soul']).toBeDefined();
    expect(typeof result.vars['soul']).toBe('string');
    expect(result.totalTokens).toBe(0);
  });

  test('query result lands in vars keyed by query name', async () => {
    const q = makeQuery('conversation', 3, 'User: hi\n\nKlaus: hello', 20, 'oldest');
    const result = await assembleContext(makeTurn(), [q]);
    expect(result.vars['conversation']).toBe('User: hi\n\nKlaus: hello');
  });

  test('all query results land in vars', async () => {
    const queries = [
      makeQuery('graph_context', 2, 'graph', 5, 'always'),
      makeQuery('conversation', 3, 'convo', 5, 'oldest'),
      makeQuery('active_tasks', 4, 'tasks', 5, 'always'),
    ];
    const result = await assembleContext(makeTurn(), queries);
    expect(result.vars['graph_context']).toBe('graph');
    expect(result.vars['conversation']).toBe('convo');
    expect(result.vars['active_tasks']).toBe('tasks');
  });

  test('arbitrary query names land in vars', async () => {
    const q = makeQuery('unknown_thing', 2, 'whatever', 5, 'always');
    const result = await assembleContext(makeTurn(), [q]);
    expect(result.totalTokens).toBe(5);
    expect(result.vars['unknown_thing']).toBe('whatever');
  });

  test('sums tokenCount across all queries', async () => {
    const queries = [
      makeQuery('conversation', 3, 'a', 300, 'oldest'),
      makeQuery('graph_context', 2, 'b', 700, 'always'),
    ];
    const result = await assembleContext(makeTurn(), queries);
    expect(result.totalTokens).toBe(1000);
  });

  test('failed query is skipped, others continue', async () => {
    const bad: ContextQuery = {
      name: 'conversation',
      priority: 3,
      run: async () => { throw new Error('DB exploded'); },
    };
    const good = makeQuery('graph_context', 2, 'graph data', 5, 'always');
    const result = await assembleContext(makeTurn(), [bad, good]);
    expect(result.vars['graph_context']).toBe('graph data');
    expect(result.vars['conversation']).toBeUndefined(); // failed, not set
  });

  // ─── flag injections ──────────────────────────────────────────────────────

  test('flags: { test: true } → flags gets test prompt string', async () => {
    const result = await assembleContext(makeTurn({ flags: { test: true } }), [flagsQuery]);
    expect(result.vars['flags']).toBe('Dies ist ein Test. Ist dies in den Prompt geraten, bitte erwähnen.');
  });

  test('unknown flag → flags var is empty string', async () => {
    const result = await assembleContext(makeTurn({ flags: { unknown: true } }), [flagsQuery]);
    expect(result.vars['flags']).toBe('');
  });

  test('flagsQuery tokenCount is 0', async () => {
    const result = await assembleContext(makeTurn({ flags: { test: true } }), [flagsQuery]);
    expect(result.totalTokens).toBe(0);
  });

  // ─── contextParams forwarding ─────────────────────────────────────────────

  test('contextParams on agent are forwarded to query run()', async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const spy: ContextQuery = {
      name: 'conversation',
      priority: 3,
      run: async (_turn, params) => {
        capturedParams = params;
        return { content: '', tokenCount: 0, truncate: 'never' as const };
      },
    };
    const agent: AgentDefinition = {
      ...dummyAgent,
      contextParams: { conversation: { limit: 5 } },
    };
    await assembleContext(makeTurn({ agent }), [spy]);
    expect(capturedParams).toEqual({ limit: 5 });
  });

  test('query with no matching contextParams receives undefined', async () => {
    let capturedParams: Record<string, unknown> | undefined = { sentinel: true };
    const spy: ContextQuery = {
      name: 'graph_context',
      priority: 2,
      run: async (_turn, params) => {
        capturedParams = params;
        return { content: '', tokenCount: 0, truncate: 'never' as const };
      },
    };
    // contextParams only defines 'conversation', not 'graph_context'
    const agent: AgentDefinition = {
      ...dummyAgent,
      contextParams: { conversation: { limit: 5 } },
    };
    await assembleContext(makeTurn({ agent }), [spy]);
    expect(capturedParams).toBeUndefined();
  });

  // ─── trimming: always ─────────────────────────────────────────────────────

  test('under budget → no trimming', async () => {
    // 50_000 + 40_000 = 90_000 < 100_000 → no trim
    const queries = [
      makeQuery('graph_context', 2, 'graph content', 50_000, 'always'),
      makeQuery('conversation', 3, 'convo', 40_000, 'oldest'),
    ];
    const result = await assembleContext(makeTurn(), queries);
    expect(result.vars['graph_context']).toBe('graph content');
    expect(result.vars['conversation']).toBe('convo');
    expect(result.totalTokens).toBe(90_000);
  });

  test('over budget: always-truncate query is cleared (priority 2 trimmed before priority 3)', async () => {
    // 60_000 + 60_000 = 120_000 > 100_000 → excess 20_000
    // graph_context (priority 2, always) is trimmed before conversation (priority 3, oldest)
    const queries = [
      makeQuery('graph_context', 2, 'graph content', 60_000, 'always'),
      makeQuery('conversation', 3, 'Turn 1\n\nTurn 2', 60_000, 'oldest'),
    ];
    const result = await assembleContext(makeTurn(), queries);
    expect(result.vars['graph_context']).toBe('');
    expect(result.vars['conversation']).toBe('Turn 1\n\nTurn 2'); // untouched
    expect(result.totalTokens).toBe(60_000);
  });

  test('over budget: never-truncate is protected even with lowest priority number', async () => {
    // conversation (priority 1, never) cannot be trimmed
    // graph_context (priority 2, always) is trimmed instead
    const queries = [
      makeQuery('conversation', 1, 'important convo', 60_000, 'never'),
      makeQuery('graph_context', 2, 'less important graph', 60_000, 'always'),
    ];
    const result = await assembleContext(makeTurn(), queries);
    expect(result.vars['conversation']).toBe('important convo'); // protected
    expect(result.vars['graph_context']).toBe(''); // cleared
  });

  // ─── trimming: oldest ────────────────────────────────────────────────────

  test('over budget: oldest-truncate removes blocks from front', async () => {
    // Excess = 3 tokens (just enough to remove the first block)
    // Each block is ~9 chars → Math.ceil((9+2)/4) = 3 tokens
    const queries = [
      makeQuery('conversation', 3, 'Block 1\n\nBlock 2\n\nBlock 3', 100_003, 'oldest'),
    ];
    const result = await assembleContext(makeTurn(), queries);
    // First block removed to cover excess of 3
    expect(result.vars['conversation']).not.toContain('Block 1');
    expect(result.vars['conversation']).toContain('Block 2');
    expect(result.vars['conversation']).toContain('Block 3');
  });

  test('over budget: oldest clears content if all blocks must be removed', async () => {
    // 60_000 + 60_000 = 120_000 > 100_000 → excess 20_000
    // Only conversation (oldest) is trimmable; it gets drained entirely
    const queries = [
      makeQuery('graph_context', 2, 'important graph', 60_000, 'never'),
      makeQuery('conversation', 3, 'Turn 1\n\nTurn 2', 60_000, 'oldest'),
    ];
    const result = await assembleContext(makeTurn(), queries);
    expect(result.vars['conversation']).toBe('');
  });

  // ─── totalTokens reflects post-trim state ────────────────────────────────

  test('totalTokens reflects post-trim state', async () => {
    const queries = [
      makeQuery('graph_context', 2, 'stuff', 80_000, 'always'),
      makeQuery('conversation', 3, 'convo', 40_000, 'never'),
    ];
    // Pre-trim total: 120_000. graph_context (priority 2, always) cleared → 40_000.
    const result = await assembleContext(makeTurn(), queries);
    expect(result.totalTokens).toBe(40_000);
  });
});
