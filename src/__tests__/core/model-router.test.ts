import { describe, expect, test, mock, beforeEach } from 'bun:test';
import type { ModelMessage } from 'ai';
import { config } from '@/config';

// ---- Mocks (must be set up before any import of the module under test) ----

const mockGenerateText = mock(async (_opts: Record<string, unknown>) => ({
  text: 'Hello from the model',
  steps: [{ usage: { inputTokens: 100, outputTokens: 50 } }],
}));

const mockInsert = mock(() => ({ values: mock(async () => [{}]) }));
const mockDb = { insert: mockInsert };

const mockStepCountIs = mock((n: number) => ({ __stepCount: n }));

mock.module('ai', () => ({
  generateText: mockGenerateText,
  embed: mock(async () => ({ embedding: [], usage: { tokens: 0 } })),
  stepCountIs: mockStepCountIs,
  tool: mock((opts: unknown) => opts),
}));
mock.module('@ai-sdk/anthropic', () => ({ anthropic: mock((id: string) => ({ id })) }));
mock.module('../../db/client', () => ({ db: mockDb }));

import { _resetForTest } from '@/core/rate-limiter';
const { callModel } = await import('../../core/model-router');

// ---- Helpers ----

const BASE_OPTS = {
  tier: 'default' as const,
  chatId: 'user@s.whatsapp.net',
  messages: [{ role: 'user', content: 'hi' }] as ModelMessage[],
};

beforeEach(() => {
  _resetForTest();
  mockGenerateText.mockClear();
  mockInsert.mockClear();
});

// ---- Tests ----

describe('callModel', () => {
  test('returns model text as content', async () => {
    const result = await callModel(BASE_OPTS);
    expect(result.content).toBe('Hello from the model');
  });

  test('aggregates inputTokens → promptTokens across steps', async () => {
    mockGenerateText.mockImplementationOnce(async () => ({
      text: 'ok',
      steps: [
        { usage: { inputTokens: 200, outputTokens: 30 } },
        { usage: { inputTokens: 50, outputTokens: 10 } },
      ],
    }));
    const result = await callModel(BASE_OPTS);
    expect(result.usage.promptTokens).toBe(250);
    expect(result.usage.completionTokens).toBe(40);
  });

  test('inserts a row into llm_costs after each call', async () => {
    await callModel(BASE_OPTS);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  test('throws when LLM rate limit is exceeded', async () => {
    for (let i = 0; i < config.rateLimits.modelCalls.max; i++) {
      await callModel(BASE_OPTS);
    }
    await expect(callModel(BASE_OPTS)).rejects.toThrow('LLM rate limit exceeded');
  });

  test('uses the model ID from config for the requested tier', async () => {
    for (const tier of ['default', 'high', 'low'] as const) {
      mockGenerateText.mockClear();
      await callModel({ ...BASE_OPTS, tier });
      const [modelArg] = mockGenerateText.mock.calls[0]!;
      expect((modelArg as { model: { id: string } }).model.id).toBe(config.models[tier]);
    }
  });

  test('each tier resolves to a distinct model ID', () => {
    expect(config.models.default).not.toBe(config.models.high);
    expect(config.models.default).not.toBe(config.models.low);
    expect(config.models.high).not.toBe(config.models.low);
  });

  test('passes system prompt when provided', async () => {
    await callModel({ ...BASE_OPTS, system: 'You are a test agent.' });
    const [opts] = mockGenerateText.mock.calls[0]!;
    expect((opts as { system?: string }).system).toBe('You are a test agent.');
  });

  test('passes tools and stopWhen when tools provided', async () => {
    const fakeTools = { reply: { description: 'Reply', parameters: {}, execute: async () => 'sent' } };
    await callModel({ ...BASE_OPTS, tools: fakeTools as never });
    const [opts] = mockGenerateText.mock.calls[0]!;
    expect((opts as { stopWhen?: unknown }).stopWhen).toEqual({ __stepCount: 10 });
  });

  test('does not set stopWhen when no tools provided', async () => {
    await callModel(BASE_OPTS);
    const [opts] = mockGenerateText.mock.calls[0]!;
    expect((opts as { stopWhen?: unknown }).stopWhen).toBeUndefined();
  });
});
