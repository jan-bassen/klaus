import { and, gte, lte, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import type { ToolDefinition, ToolsetDefinition } from '@/types';
import { dispatch } from '@/core/dispatch';
import { db } from '@/db/client';
import { agentInvocations, apiCosts, llmBudgets } from '@/db/schema';
import { QUERIES } from '@/db/queries';

const opsCronSchema = z.object({
  pattern: z.string().describe('Cron expression'),
  agentName: z.string(),
  label: z.string().describe('Human-readable label for this scheduled job'),
});

export const opsCronTool: ToolDefinition<typeof opsCronSchema> = {
  name: 'ops.cron',
  description: 'Schedule an agent to run on a cron pattern.',
  inputSchema: opsCronSchema,
  execute: async (input, context) => {
    await dispatch({
      agent: input.agentName,
      objective: `Scheduled: ${input.label}`,
      mode: { kind: 'cron', schedule: input.pattern },
      chatId: context.chatId,
      caller: context.agent.name,
    });
    return `Scheduled ${input.agentName} with pattern "${input.pattern}" (${input.label})`;
  },
  kind: 'builtin',
  capability: 'tool',
};

const opsCostTrackingSchema = z.object({
  period: z.enum(['today', 'this_month', 'last_month']).default('today'),
});

export const opsCostTrackingTool: ToolDefinition<typeof opsCostTrackingSchema> = {
  name: 'ops.cost-tracking',
  description: 'Query total spend (LLM + TTS + embeddings) and budget status.',
  inputSchema: opsCostTrackingSchema,
  execute: async (input, context) => {
    const now = new Date();
    let startDate: Date;
    let endDate: Date | undefined;

    if (input.period === 'today') {
      startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    } else if (input.period === 'this_month') {
      startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    } else {
      // last_month
      const y = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
      const m = now.getUTCMonth() === 0 ? 11 : now.getUTCMonth() - 1;
      startDate = new Date(Date.UTC(y, m, 1));
      endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    }

    const llmFilter = endDate
      ? and(gte(agentInvocations.createdAt, startDate), lte(agentInvocations.createdAt, endDate))
      : gte(agentInvocations.createdAt, startDate);

    const apiFilter = endDate
      ? and(gte(apiCosts.createdAt, startDate), lte(apiCosts.createdAt, endDate))
      : gte(apiCosts.createdAt, startDate);

    const [[llmRow], [apiRow], [budget]] = await Promise.all([
      db.select({ total: sum(agentInvocations.costUsd) }).from(agentInvocations).where(llmFilter),
      db.select({ total: sum(apiCosts.costUsd) }).from(apiCosts).where(apiFilter),
      db.select().from(llmBudgets).where(sql`chat_id = ${context.chatId}`).limit(1),
    ]);

    const llmSpent = parseFloat(llmRow?.total ?? '0');
    const apiSpent = parseFloat(apiRow?.total ?? '0');
    const totalSpent = llmSpent + apiSpent;

    const lines = [
      `Period: ${input.period}`,
      `Total: $${totalSpent.toFixed(4)}`,
      `  LLM: $${llmSpent.toFixed(4)}`,
      `  API (TTS/embed): $${apiSpent.toFixed(4)}`,
    ];
    if (budget) {
      if (budget.dailyLimitUsd) lines.push(`Daily limit: $${budget.dailyLimitUsd}`);
      if (budget.monthlyLimitUsd) lines.push(`Monthly limit: $${budget.monthlyLimitUsd}`);
    }
    return lines.join('\n');
  },
  kind: 'builtin',
  capability: 'resource',
};

const opsPostgresQuerySchema = z.object({
  queryName: z.string().describe('Name of a static named query in db/queries/'),
  params: z.record(z.unknown()).optional(),
});

export const opsPostgresQueryTool: ToolDefinition<typeof opsPostgresQuerySchema> = {
  name: 'ops.postgres-query',
  description: `Run a named read-only Postgres query. Available queries: ${Object.keys(QUERIES).join(', ')}.`,
  inputSchema: opsPostgresQuerySchema,
  execute: async (input) => {
    const fn = QUERIES[input.queryName];
    if (!fn) return `Unknown query "${input.queryName}". Available: ${Object.keys(QUERIES).join(', ')}`;
    const result = await fn(input.params ?? {});
    return JSON.stringify(result, null, 2);
  },
  kind: 'builtin',
  capability: 'resource',
};

export const opsToolset: ToolsetDefinition = {
  name: 'ops',
  description: 'Use when you need to manage cron schedules, check LLM costs, or run named Postgres queries.',
  tools: [opsCronTool, opsCostTrackingTool, opsPostgresQueryTool],
};
