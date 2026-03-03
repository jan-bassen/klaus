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
  vars: {},
  totalTokens: 0,
};

function makeTurn(vars: Record<string, string> = {}): TurnContext {
  return {
    msg: {
      kind: 'whatsapp',
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
    assembled: { ...emptyAssembled, vars },
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

  // --- contextParams: YAML ---

  test('context: YAML key is parsed into contextParams', async () => {
    const fm = 'name: ctx-agent\nmodelTier: default\ntools: []\nhooks: []\ncontext:\n  conversation:\n    limit: 10';
    await withFixture('ctx-yaml', fm, '## Hi\n', async (p) => {
      const def = await loadAgentDefinition(p);
      expect(def.contextParams?.conversation?.limit).toBe(10);
    });
  });

  // --- contextParams: inline ---

  test('{{name?key=val}} in body is parsed into contextParams', async () => {
    const fm = 'name: inline-agent\nmodelTier: default\ntools: []\nhooks: []';
    await withFixture('ctx-inline', fm, '{{conversation?limit=5}}\n', async (p) => {
      const def = await loadAgentDefinition(p);
      expect(def.contextParams?.conversation?.limit).toBe(5);
    });
  });

  test('inline params are parsed as numbers when numeric', async () => {
    const fm = 'name: num-agent\nmodelTier: default\ntools: []\nhooks: []';
    await withFixture('ctx-num', fm, '{{graph_context?limit=20&offset=5}}\n', async (p) => {
      const def = await loadAgentDefinition(p);
      expect(def.contextParams?.graph_context?.limit).toBe(20);
      expect(def.contextParams?.graph_context?.offset).toBe(5);
    });
  });

  test('inline params override YAML params per-key', async () => {
    const fm = 'name: merge-agent\nmodelTier: default\ntools: []\nhooks: []\ncontext:\n  conversation:\n    limit: 100\n    offset: 0';
    await withFixture('ctx-merge', fm, '{{conversation?limit=10}}\n', async (p) => {
      const def = await loadAgentDefinition(p);
      // inline limit wins, YAML offset is preserved
      expect(def.contextParams?.conversation?.limit).toBe(10);
      expect(def.contextParams?.conversation?.offset).toBe(0);
    });
  });

  // --- toolsets ---

  test('toolsets: YAML key is parsed into toolsets array', async () => {
    const fm = 'name: ts-agent\nmodelTier: default\ntools: []\nhooks: []\ntoolsets: [memory, files]';
    await withFixture('toolsets', fm, '## Hi\n', async (p) => {
      const def = await loadAgentDefinition(p);
      expect(def.toolsets).toEqual(['memory', 'files']);
    });
  });

  test('missing toolsets produces no toolsets property', async () => {
    await withFixture('no-toolsets', 'name: plain-agent\nmodelTier: default\ntools: []\nhooks: []', '## Hi\n', async (p) => {
      const def = await loadAgentDefinition(p);
      expect(def.toolsets).toBeUndefined();
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
    await writeAgentFile(tmpPath, '## Instructions\nYou are a test agent.\n\n{{conversation}}\n\n{{graph_context}}\n\n{{active_tasks}}\n\n{{flags}}');
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

  test('{{name?params}} placeholder resolves to var value (params stripped from output)', async () => {
    const p = path.join(import.meta.dir, '__inline-params.md');
    await Bun.write(p, '---\nname: test-agent\nmodelTier: default\ntools: []\nhooks: []\n---\n## Instructions\n{{conversation?limit=5}}\n');
    const turn = makeTurn({ conversation: 'User: hey' });
    turn.agent.promptPath = p;
    await runAgent(turn, turn.agent);
    try { unlinkSync(p); } catch { /* gone */ }
    const opts = lastArg(mockCallModel);
    const system = (opts as { system: string }).system;
    expect(system).toContain('User: hey');
    expect(system).not.toContain('?limit=5');
  });

  test('system prompt includes graph context when present', async () => {
    const turn = makeTurn({ graph_context: '### Node Title\nsome body text' });
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

  test('tools from def.toolsets are expanded and wired into callModel', async () => {
    const executeFn = mock(async () => 'ok');
    registerTool({
      name: 'ts.alpha',
      description: 'A toolset tool',
      inputSchema: z.object({ x: z.string() }),
      execute: executeFn,
      kind: 'builtin',
      capability: 'tool',
    });
    const turn = makeTurn();
    turn.agent = { ...turn.agent, toolsets: ['ts'], promptPath: tmpPath };
    await runAgent(turn, turn.agent);
    cleanup();
    toolRegistry.delete('ts.alpha');
    const opts = lastArg(mockCallModel);
    expect((opts as { tools?: Record<string, unknown> }).tools).toBeDefined();
    expect((opts as { tools: Record<string, unknown> }).tools['ts_alpha']).toBeDefined();
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
