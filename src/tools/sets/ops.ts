import { z } from 'zod';
import type { ToolDefinition, ToolsetDefinition } from '@/types';

const opsCronSchema = z.object({
  pattern: z.string().describe('Cron expression'),
  agentName: z.string(),
  label: z.string().describe('Human-readable label for this scheduled job'),
});

export const opsCronTool: ToolDefinition<typeof opsCronSchema> = {
  name: 'ops.cron',
  description: 'Schedule an agent to run on a cron pattern.',
  inputSchema: opsCronSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'tool',
};

const opsCostTrackingSchema = z.object({
  period: z.enum(['today', 'this_month', 'last_month']).default('today'),
});

export const opsCostTrackingTool: ToolDefinition<typeof opsCostTrackingSchema> = {
  name: 'ops.cost-tracking',
  description: 'Query LLM spend and budget status.',
  inputSchema: opsCostTrackingSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'resource',
};

const opsPostgresQuerySchema = z.object({
  queryName: z.string().describe('Name of a static named query in db/queries/'),
  params: z.record(z.unknown()).optional(),
});

export const opsPostgresQueryTool: ToolDefinition<typeof opsPostgresQuerySchema> = {
  name: 'ops.postgres-query',
  description: 'Run a named read-only Postgres query via the app_ro role.',
  inputSchema: opsPostgresQuerySchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'resource',
};

export const opsToolset: ToolsetDefinition = {
  name: 'ops',
  description: 'Use when you need to manage cron schedules, check LLM costs, or run named Postgres queries.',
  tools: [opsCronTool, opsCostTrackingTool, opsPostgresQueryTool],
};
