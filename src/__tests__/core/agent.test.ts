import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { unlinkSync } from 'fs';
import * as path from 'path';
import { z } from 'zod';

// ---- Mocks for runAgent (must be set up before importing agent.ts) ----
const mockCallModel = mock(async () => ({
  content: '',
  usage: { promptTokens: 10, completionTokens: 5, costUsd: 0 },
}));
mock.module('../../core/model-router', () => ({ callModel: mockCallModel }));

import { loadAgentDefinition, runAgent } from '@/core/agent';
import { registerTool, toolRegistry } from '@/tools/registry';
import type { TurnContext, AssembledContext } from '@/types';

// ---- runAgent helpers ----

const emptyAssembled: AssembledContext = {
  conversation: '',
  graphContext: '',
  activeTasks: '',
  toolDescriptions: '',
  flagInjections: '',
  totalTokens: 0,
};

function makeTurn(overrides: Partial<AssembledContext> = {}): TurnContext {
  return {
    msg: {
      id: 'msg-1',
      chatId: 'user@s.whatsapp.net',
      senderId: 'user@s.whatsapp.net',
      text: 'hello',
      timestamp: new Date(),
      messageKey: {},
    },
    agent: {
      name: 'test',
      modelTier: 'default',
      tools: [],
      promptPath: '/dev/null',
    },
    flags: {},
    assembled: { ...emptyAssembled, ...overrides },
  };
}

async function writeAgentFile(promptPath: string, body: string): Promise<void> {
  await Bun.write(
    promptPath,
    `---\nname: test-agent\nmodelTier: default\ntools: []\nhooks: []\n---\n${body}`,
  );
}

// Helper: write a minimal valid agent fixture and clean it up after the test.
async function withFixture(
  name: string,
  frontmatter: string,
  body: string,
  fn: (p: string) => Promise<void>,
): Promise<void> {
  const p = path.join(import.meta.dir, `__fixture-${name}.md`);
  await Bun.write(p, `---\n${frontmatter}\n---\n${body}`);
  try {
    await fn(p);
  } finally {
    try { unlinkSync(p); } catch { /* already gone */ }
  }
}

describe('loadAgentDefinition', () => {
  // --- basic shape ---

  test('parses name and modelTier from frontmatter', async () => {
    await withFixture('basic', 'name: my-agent\nmodelTier: default\ntools: []\nhooks: []', '## Hi\n', async (p) => {
      const def = await loadAgentDefinition(p);
      expect(def.name).toBe('my-agent');
      expect(def.modelTier).toBe('default');
    });
  });

  test('parses "high" modelTier correctly', async () => {
    await withFixture('high-tier', 'name: deep-agent\nmodelTier: high\ntools: []\nhooks: []', '## Hi\n', async (p) => {
      const def = await loadAgentDefinition(p);
      expect(def.modelTier).toBe('high');
    });
  });

  test('promptPath is the absolute path passed in', async () => {
    await withFixture('path', 'name: path-agent\nmodelTier: default\ntools: []\nhooks: []', '## Hi\n', async (p) => {
      const def = await loadAgentDefinition(p);
      expect(def.promptPath).toBe(p);
    });
  });

  // --- tools ---

  test('tools are parsed as an array of strings', async () => {
    await withFixture('tools', 'name: tool-agent\nmodelTier: default\ntools: [alpha, beta]\nhooks: []', '## Hi\n', async (p) => {
      const def = await loadAgentDefinition(p);
      expect(def.tools).toEqual(['alpha', 'beta']);
    });
  });

  // --- hooks: runAfter form ---

  test('runAfter hooks are normalized to {hook, signal} objects', async () => {
    const fm = 'name: hook-agent\nmodelTier: default\ntools: []\nhooks:\n  runAfter:\n    - hook: summarize\n      signal: Done';
    await withFixture('hooks', fm, '## Hi\n', async (p) => {
      const def = await loadAgentDefinition(p);
      expect(def.hooks).toBeDefined();
      expect(def.hooks!.length).toBe(1);
      expect(def.hooks![0]!.hook).toBe('summarize');
      expect(def.hooks![0]!.signal).toBe('Done');
    });
  });

  // --- hooks: empty array form ---

  test('empty hooks list produces no hooks property', async () => {
    await withFixture('no-hooks', 'name: quiet-agent\nmodelTier: default\ntools: []\nhooks: []', '## Hi\n', async (p) => {
      const def = await loadAgentDefinition(p);
      expect(def.hooks).toBeUndefined();
    });
  });

  // --- unknown fields are ignored ---

  test('unknown frontmatter fields are silently ignored', async () => {
    const fm = 'name: scheduled-agent\nmodelTier: default\ntools: []\nhooks: []\nschedule: "0 * * * *"';
    await withFixture('unknown-field', fm, '## Hi\n', async (p) => {
      const def = await loadAgentDefinition(p);
      expect(def.name).toBe('scheduled-agent');
    });
  });

  // --- error cases ---

  test('throws when file has no frontmatter', async () => {
    const tmpPath = path.join(import.meta.dir, '__no-frontmatter.md');
    await Bun.write(tmpPath, '# Just a heading\nNo frontmatter here.');
    try {
      await expect(loadAgentDefinition(tmpPath)).rejects.toThrow('No YAML frontmatter');
    } finally {
      unlinkSync(tmpPath);
    }
  });

  test('throws when modelTier is invalid', async () => {
    const tmpPath = path.join(import.meta.dir, '__bad-tier.md');
    await Bun.write(tmpPath, '---\nname: bad\nmodelTier: nonexistent\ntools: []\nhooks: []\n---\n## hi\n');
    try {
      await expect(loadAgentDefinition(tmpPath)).rejects.toThrow("Invalid 'modelTier'");
    } finally {
      unlinkSync(tmpPath);
    }
  });
});

/** Extract the first argument of the most recent mock call. */
function lastArg(m: ReturnType<typeof mock>): unknown {
  const calls = m.mock.calls as unknown[][];
  return calls[calls.length - 1]?.[0];
}

// ---- runAgent tests ----

describe('runAgent', () => {
  const tmpPath = path.join(import.meta.dir, '__runagent-test.md');

  beforeEach(async () => {
    mockCallModel.mockClear();
    mockCallModel.mockImplementation(async () => ({
      content: '',
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0 },
    }));
    await writeAgentFile(tmpPath, '## Instructions\nYou are a test agent.');
  });

  const cleanup = () => { try { unlinkSync(tmpPath); } catch { /* already gone */ } };

  test('calls callModel with correct tier and chatId', async () => {
    const turn = makeTurn();
    turn.agent.promptPath = tmpPath;
    await runAgent(turn, turn.agent);
    cleanup();
    expect(mockCallModel).toHaveBeenCalledTimes(1);
    const opts = lastArg(mockCallModel);
    expect((opts as { tier: string }).tier).toBe('default');
    expect((opts as { chatId: string }).chatId).toBe('user@s.whatsapp.net');
  });

  test('system prompt includes agent body', async () => {
    const turn = makeTurn();
    turn.agent.promptPath = tmpPath;
    await runAgent(turn, turn.agent);
    cleanup();
    const opts = lastArg(mockCallModel);
    expect((opts as { system: string }).system).toContain('You are a test agent.');
  });

  test('system prompt includes assembled conversation', async () => {
    const turn = makeTurn({ conversation: 'User: hi\n\nKlaus: hello' });
    turn.agent.promptPath = tmpPath;
    await runAgent(turn, turn.agent);
    cleanup();
    const opts = lastArg(mockCallModel);
    expect((opts as { system: string }).system).toContain('User: hi');
  });

  test('system prompt includes graph context when present', async () => {
    const turn = makeTurn({ graphContext: '### Node Title\nsome body text' });
    turn.agent.promptPath = tmpPath;
    await runAgent(turn, turn.agent);
    cleanup();
    const opts = lastArg(mockCallModel);
    expect((opts as { system: string }).system).toContain('### Node Title');
  });

  test('returns undefined when model returns non-JSON text', async () => {
    mockCallModel.mockImplementationOnce(async () => ({
      content: 'Sure, I can help with that!',
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0 },
    }));
    const turn = makeTurn();
    turn.agent.promptPath = tmpPath;
    const result = await runAgent(turn, turn.agent);
    cleanup();
    expect(result).toBeUndefined();
  });

  test('returns parsed AgentReturn when model returns valid JSON', async () => {
    mockCallModel.mockImplementationOnce(async () => ({
      content: JSON.stringify({ hooks: { HookSignal: { fire: true } } }),
      usage: { promptTokens: 10, completionTokens: 5, costUsd: 0 },
    }));
    const turn = makeTurn();
    turn.agent.promptPath = tmpPath;
    const result = await runAgent(turn, turn.agent);
    cleanup();
    expect(result).toBeDefined();
    expect(result!.hooks?.HookSignal?.fire).toBe(true);
  });

  test('tools from registry are wired into callModel', async () => {
    const executeFn = mock(async () => 'ok');
    registerTool({
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: z.object({ msg: z.string() }),
      execute: executeFn,
      kind: 'builtin',
      capability: 'tool',
    });
    const turn = makeTurn();
    turn.agent = { ...turn.agent, tools: ['test-tool'], promptPath: tmpPath };
    await runAgent(turn, turn.agent);
    cleanup();
    toolRegistry.delete('test-tool');
    const opts = lastArg(mockCallModel);
    expect((opts as { tools?: Record<string, unknown> }).tools).toBeDefined();
    expect((opts as { tools: Record<string, unknown> }).tools['test-tool']).toBeDefined();
  });

  test('unknown tools are silently omitted from callModel', async () => {
    const turn = makeTurn();
    turn.agent = { ...turn.agent, tools: ['nonexistent-tool'], promptPath: tmpPath };
    await runAgent(turn, turn.agent);
    cleanup();
    const opts = lastArg(mockCallModel);
    expect((opts as { tools?: Record<string, unknown> }).tools).toBeUndefined();
  });
});
