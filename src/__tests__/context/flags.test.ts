import { describe, expect, test } from 'bun:test';
import { flagsQuery } from '@/context/flags';
import { FLAG_MAP } from '@/whatsapp/flags';
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

const dummyAgent: AgentDefinition = {
  name: 'test',
  modelTier: 'default',
  tools: [],
  promptPath: '/dev/null',
};

function makeTurn(flags: Record<string, boolean>): Omit<TurnContext, 'assembled'> {
  return { msg: dummyMsg, agent: dummyAgent, flags };
}

describe('flagsQuery', () => {
  test('name and priority are correct', () => {
    expect(flagsQuery.name).toBe('flag_injections');
    expect(flagsQuery.priority).toBe(0);
  });

  test('no flags → empty content and zero tokens', async () => {
    const result = await flagsQuery.run(makeTurn({}));
    expect(result.content).toBe('');
    expect(result.tokenCount).toBe(0);
  });

  test('truncate is always never', async () => {
    const result = await flagsQuery.run(makeTurn({}));
    expect(result.truncate).toBe('never');
  });

  test('single flag → its promptInjection', async () => {
    const result = await flagsQuery.run(makeTurn({ verbose: true }));
    expect(result.content).toBe(FLAG_MAP.verbose!.promptInjection);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  test('two flags → injections joined with newline', async () => {
    const result = await flagsQuery.run(makeTurn({ verbose: true, debug: true }));
    const expected = [
      FLAG_MAP.verbose!.promptInjection,
      FLAG_MAP.debug!.promptInjection,
    ].join('\n');
    expect(result.content).toBe(expected);
  });

  test('all four flags → four injections', async () => {
    const result = await flagsQuery.run(
      makeTurn({ verbose: true, concise: true, debug: true, raw: true }),
    );
    const lines = result.content.split('\n');
    expect(lines).toHaveLength(4);
  });

  test('false flags are excluded', async () => {
    const result = await flagsQuery.run(makeTurn({ verbose: false, debug: true }));
    expect(result.content).toBe(FLAG_MAP.debug!.promptInjection);
  });

  test('unrecognized flag key is ignored', async () => {
    const result = await flagsQuery.run(makeTurn({ banana: true }));
    expect(result.content).toBe('');
    expect(result.tokenCount).toBe(0);
  });

  test('truncate is never even with active flags', async () => {
    const result = await flagsQuery.run(makeTurn({ verbose: true }));
    expect(result.truncate).toBe('never');
  });
});
