import { z } from 'zod';
import type { ToolDefinition } from '@/types';

// task.create — surface tool (always available)
const taskCreateSchema = z.object({
  objective: z.string().describe('What the task should accomplish'),
  agentName: z.string().describe('Which agent to assign the task to'),
  input: z.record(z.unknown()).optional().describe('Input data for the agent'),
});

export const taskCreateTool: ToolDefinition<typeof taskCreateSchema> = {
  name: 'task.create',
  description: 'Create an async task and enqueue it for the assigned agent.',
  inputSchema: taskCreateSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'tool',
  surface: true,
};

// task.cancel
const taskCancelSchema = z.object({
  taskId: z.string().uuid(),
});

export const taskCancelTool: ToolDefinition<typeof taskCancelSchema> = {
  name: 'task.cancel',
  description: 'Cancel a pending or running task.',
  inputSchema: taskCancelSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'tool',
};

// task.list
const taskListSchema = z.object({
  status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled']).optional(),
});

export const taskListTool: ToolDefinition<typeof taskListSchema> = {
  name: 'task.list',
  description: 'List tasks, optionally filtered by status.',
  inputSchema: taskListSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'resource',
};

export const taskToolset = [taskCreateTool, taskCancelTool, taskListTool];
