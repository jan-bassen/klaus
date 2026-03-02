import type { ModelMessage, ToolSet } from 'ai';
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { config, type ModelTier } from '@/config';
import { checkModelRate } from './rate-limiter';
import { db } from '@/db/client';
import { llmCosts } from '@/db/schema';

export interface ModelCallOptions {
  tier: ModelTier;
  chatId: string;
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  schema?: unknown;
}

export interface ModelCallResult {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  };
}

/**
 * Resolves the model tier to a provider+model, enforces the LLM-level rate limit,
 * calls the Vercel AI SDK, and records cost.
 */
export async function callModel(opts: ModelCallOptions): Promise<ModelCallResult> {
  const rate = checkModelRate(opts.chatId);
  if (!rate.allowed) {
    throw new Error(`LLM rate limit exceeded. Retry in ${rate.retryAfterMs}ms`);
  }

  const modelId = config.models[opts.tier];
  const model = anthropic(modelId);

  const result = await generateText({
    model,
    ...(opts.system ? { system: opts.system } : {}),
    messages: opts.messages,
    ...(opts.tools && Object.keys(opts.tools).length > 0
      ? { tools: opts.tools, maxSteps: 10 }
      : {}),
  });

  // Aggregate token usage across all steps (maxSteps may run multiple LLM calls).
  // ai@6 uses inputTokens/outputTokens on LanguageModelUsage.
  const promptTokens = result.steps.reduce((s, st) => s + (st.usage.inputTokens ?? 0), 0);
  const completionTokens = result.steps.reduce((s, st) => s + (st.usage.outputTokens ?? 0), 0);
  const costUsd = 0; // TODO: add pricing table per model

  await db.insert(llmCosts).values({
    model: modelId,
    promptTokens,
    completionTokens,
    costUsd: String(costUsd),
    createdAt: new Date(),
  });

  return {
    content: result.text,
    usage: { promptTokens, completionTokens, costUsd },
  };
}
