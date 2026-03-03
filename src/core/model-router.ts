import type { ModelMessage, ToolSet } from 'ai';
import { generateText, stepCountIs } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { config, type ModelTier } from '@/config';
import { checkModelRate } from './rate-limiter';
import { db } from '@/db/client';
import { agentInvocations } from '@/db/schema';
import { log } from '@/logger';

export interface ModelCallOptions {
  tier: ModelTier;
  chatId?: string;
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  schema?: unknown;
  messageId?: string;
  taskId?: string;
  agentName?: string;
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
 * calls the Vercel AI SDK, and records the full invocation trace including cost.
 */
export async function callModel(opts: ModelCallOptions): Promise<ModelCallResult> {
  const rate = checkModelRate();
  if (!rate.allowed) {
    log.warn('[model-router] LLM rate limited', { retryAfterMs: rate.retryAfterMs });
    throw new Error(`LLM rate limit exceeded. Retry in ${rate.retryAfterMs}ms`);
  }

  const modelId = config.models[opts.tier];
  const model = anthropic(modelId);

  const startTime = Date.now();
  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      model,
      ...(opts.system ? { system: opts.system } : {}),
      messages: opts.messages,
      ...(opts.tools && Object.keys(opts.tools).length > 0
        ? { tools: opts.tools, stopWhen: stepCountIs(10) }
        : {}),
    });
  } catch (err) {
    log.error('[model-router] generateText failed', {
      model: modelId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }

  const durationMs = Date.now() - startTime;

  // Aggregate token usage across all steps (maxSteps may run multiple LLM calls).
  // ai@6 uses inputTokens/outputTokens on LanguageModelUsage.
  const promptTokens = result.steps.reduce((s, st) => s + (st.usage.inputTokens ?? 0), 0);
  const completionTokens = result.steps.reduce((s, st) => s + (st.usage.outputTokens ?? 0), 0);
  const costUsd = 0; // TODO: add pricing table per model
  log.warn('[model-router] cost tracking not implemented — recording 0', { model: modelId });

  // Serialize steps: pick only the fields useful for debugging.
  // reasoning is populated when extended thinking is enabled (providerOptions.thinking).
  const steps = result.steps.map((s) => ({
    text: s.text,
    reasoning: s.reasoning,
    toolCalls: s.toolCalls,
    toolResults: s.toolResults,
    finishReason: s.finishReason,
    usage: s.usage,
  }));

  const userMessage =
    opts.messages.length > 0
      ? typeof opts.messages[0]!.content === 'string'
        ? opts.messages[0]!.content
        : JSON.stringify(opts.messages[0]!.content)
      : undefined;

  await db.insert(agentInvocations).values({
    agent: opts.agentName ?? 'unknown',
    model: modelId,
    ...(opts.messageId ? { messageId: opts.messageId } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.system ? { systemPrompt: opts.system } : {}),
    ...(userMessage ? { userMessage } : {}),
    steps,
    promptTokens,
    completionTokens,
    costUsd: String(costUsd),
    durationMs,
    createdAt: new Date(),
  });

  return {
    content: result.text,
    usage: { promptTokens, completionTokens, costUsd },
  };
}
