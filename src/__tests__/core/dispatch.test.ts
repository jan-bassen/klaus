import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AgentDefinition, DispatchOptions } from '@/types';
import { config } from '@/config';

// ─── mocks (avoid mock.module('@/core/agent') — it poisons agent.test.ts) ───

const mockAssembleContext = mock(async () => ({ vars: {}, totalTokens: 0 }));
mock.module('@/core/assemble', () => ({ assembleContext: mockAssembleContext }));

const mockEnqueueJob = mock(async () => {});
const mockScheduleJob = mock(async () => {});
mock.module('@/core/queue', () => ({
  enqueueJob: mockEnqueueJob,
  scheduleJob: mockScheduleJob,
}));

const mockInsertReturning = mock(async () => [{ id: 'task-uuid-1' }]);
const mockUpdateSet = mock(() => ({ where: mock(async () => {}) }));
const mockDb = {
  insert: mock(() => ({
    values: mock(() => ({
      returning: mockInsertReturning,
    })),
  })),
  update: mock(() => ({
    set: mockUpdateSet,
  })),
};
mock.module('@/db/client', () => ({ db: mockDb }));
mock.module('@/db/schema', () => ({ tasks: {}, agentInvocations: {} }));

mock.module('@/logger', () => ({
  log: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) },
}));

// Import after mocks, then install test seams for agent functions
const { dispatch, markTaskRunning, markTaskDone, markTaskFailed, _setDispatchSeamsForTest, _clearDispatchSeamsForTest } = await import('@/core/dispatch');
const { agentRegistry } = await import('@/core/agent');

const mockRunAgent = mock(async () => {});
const mockLoadAgentDefinition = mock(async (_path: string): Promise<AgentDefinition> => ({
  name: 'helper',
  modelTier: 'default',
  tools: [],
  promptPath: '/agents/helper.md',
}));

_setDispatchSeamsForTest({
  runAgent: mockRunAgent as any,
  loadAgentDefinition: mockLoadAgentDefinition as any,
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeOpts(overrides: Partial<DispatchOptions> = {}): DispatchOptions {
  return {
    agent: 'helper',
    objective: 'Do the thing',
    mode: { kind: 'async' },
    chatId: 'user@s.whatsapp.net',
    caller: 'klaus',
    depth: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockRunAgent.mockClear();
  mockLoadAgentDefinition.mockClear();
  mockAssembleContext.mockClear();
  mockEnqueueJob.mockClear();
  mockScheduleJob.mockClear();
  mockInsertReturning.mockClear();
  mockInsertReturning.mockImplementation(async () => [{ id: 'task-uuid-1' }]);
  agentRegistry.clear();
});

afterEach(() => {
  _clearDispatchSeamsForTest();
  _setDispatchSeamsForTest({
    runAgent: mockRunAgent as any,
    loadAgentDefinition: mockLoadAgentDefinition as any,
  });
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe('dispatch', () => {
  test('inline mode calls runAgent and returns undefined', async () => {
    const result = await dispatch(makeOpts({ mode: { kind: 'inline' } }));
    expect(result).toBeUndefined();
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  test('async mode inserts task, enqueues job, returns task ID', async () => {
    const result = await dispatch(makeOpts({ mode: { kind: 'async' } }));
    expect(result).toBe('task-uuid-1');
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  test('cron mode calls scheduleJob and returns undefined', async () => {
    const result = await dispatch(makeOpts({ mode: { kind: 'cron', schedule: '0 3 * * *' } }));
    expect(result).toBeUndefined();
    expect(mockScheduleJob).toHaveBeenCalledTimes(1);
    expect((mockScheduleJob.mock.calls[0] as any[])[1]).toBe('0 3 * * *');
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  test('max chain depth returns undefined without running', async () => {
    const result = await dispatch(makeOpts({ depth: config.dispatch.maxChainDepth }));
    expect(result).toBeUndefined();
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  test('async dispatch passes depth+1 in the enqueued payload', async () => {
    await dispatch(makeOpts({ mode: { kind: 'async' }, depth: 3 }));
    const payload = (mockEnqueueJob.mock.calls[0] as any[])[0];
    expect(payload.depth).toBe(4);
  });

  test('loads agent from disk when not in registry', async () => {
    await dispatch(makeOpts({ mode: { kind: 'inline' } }));
    expect(mockLoadAgentDefinition).toHaveBeenCalledTimes(1);
  });

  test('uses cached agent when in registry', async () => {
    const cached: AgentDefinition = {
      name: 'helper',
      modelTier: 'default',
      tools: [],
      promptPath: '/agents/helper.md',
    };
    agentRegistry.set('helper', cached);

    await dispatch(makeOpts({ mode: { kind: 'inline' } }));
    expect(mockLoadAgentDefinition).not.toHaveBeenCalled();
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });
});

describe('task status transitions', () => {
  test('markTaskRunning updates task status', async () => {
    await markTaskRunning('task-1');
    expect(mockDb.update).toHaveBeenCalled();
  });

  test('markTaskDone updates task status', async () => {
    await markTaskDone('task-1');
    expect(mockDb.update).toHaveBeenCalled();
  });

  test('markTaskFailed updates task status', async () => {
    await markTaskFailed('task-1');
    expect(mockDb.update).toHaveBeenCalled();
  });
});
