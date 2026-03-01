import type { ModelTier } from '../config';

export interface ModelCallOptions {
  tier: ModelTier;
  chatId: string;
  messages: unknown[];
  tools?: unknown[];
  schema?: unknown;
}

export interface ModelCallResult {
  content: string | unknown;
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
export async function callModel(_opts: ModelCallOptions): Promise<ModelCallResult> {
  throw new Error('TODO: not implemented');
}
