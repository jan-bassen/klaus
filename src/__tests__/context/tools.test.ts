import { describe, expect, test, afterEach } from 'bun:test';
import { z } from 'zod';
import { toolsQuery } from '@/context/tools';
import { registerTool, toolRegistry } from '@/tools/registry';
import type { AgentDefinition, InboundMessage, TurnContext } from '@/types';

const dummyMsg: InboundMessage = {
  kind: 'whatsapp',
  id: 'test-id',
  chatId: 'user@s.whatsapp.net',
  senderId: 'user@s.whatsapp.net',
  text: 'hi',
  timestamp: new Date(),
  messageKey: {},
};

function makeTurn(toolNames: string[]): Omit<TurnContext, 'assembled'> {
  const agent: AgentDefinition = {
    name: 'test',
    modelTier: 'default',
    tools: toolNames,
    promptPath: '/dev/null',
  };
  return { msg: dummyMsg, agent, flags: {} };
}

function fakeTool(name: string, description: string) {
  return {
    name,
    description,
    inputSchema: z.object({}),
    execute: async () => 'ok',
    kind: 'builtin' as const,
    capability: 'tool' as const,
  };
}

// Clean up any tools registered during tests.
const registeredNames: string[] = [];
afterEach(() => {
  for (const name of registeredNames.splice(0)) toolRegistry.delete(name);
});

function register(name: string, description: string) {
  registerTool(fakeTool(name, description));
  registeredNames.push(name);
}

describe('toolsQuery', () => {
  test('name is "tool_descriptions" with priority 1', () => {
    expect(toolsQuery.name).toBe('tool_descriptions');
    expect(toolsQuery.priority).toBe(1);
  });

  test('truncate is always "never"', async () => {
    const result = await toolsQuery.run(makeTurn([]));
    expect(result.truncate).toBe('never');
  });

  test('empty tools list → empty content and zero tokenCount', async () => {
    const result = await toolsQuery.run(makeTurn([]));
    expect(result.content).toBe('');
    expect(result.tokenCount).toBe(0);
  });

  test('tool in registry is formatted as **name**: description', async () => {
    register('reply', 'Send a WhatsApp message');
    const result = await toolsQuery.run(makeTurn(['reply']));
    expect(result.content).toBe('**reply**: Send a WhatsApp message');
  });

  test('unknown tool name is silently skipped', async () => {
    const result = await toolsQuery.run(makeTurn(['nonexistent-tool']));
    expect(result.content).toBe('');
    expect(result.tokenCount).toBe(0);
  });

  test('multiple tools are joined with newlines', async () => {
    register('alpha', 'First tool');
    register('beta', 'Second tool');
    const result = await toolsQuery.run(makeTurn(['alpha', 'beta']));
    expect(result.content).toBe('**alpha**: First tool\n**beta**: Second tool');
  });

  test('known tools are listed; unknown tools are skipped', async () => {
    register('known', 'A known tool');
    const result = await toolsQuery.run(makeTurn(['known', 'missing']));
    expect(result.content).toBe('**known**: A known tool');
  });

  test('tokenCount is ceil(content.length / 4)', async () => {
    register('calc', 'A calculator');
    const result = await toolsQuery.run(makeTurn(['calc']));
    expect(result.tokenCount).toBe(Math.ceil(result.content.length / 4));
  });
});
