import { z } from 'zod';
import type { ToolDefinition, ToolsetDefinition } from '@/types';
import { dispatch as dispatchAgent } from '@/core/dispatch';

// dispatch — surface tool (always available)
// Wraps the unified dispatch() primitive. Agents use this to invoke other agents.
const dispatchSchema = z.object({
  agent: z.string().describe('Name of the agent to invoke'),
  objective: z.string().describe('What the agent should accomplish'),
  hint: z.string().optional().describe('Optional additional context or instructions for the agent'),
  mode: z.enum(['async', 'inline']).default('async').describe(
    'async: fire-and-forget background job (returns task ID); inline: run now and return result',
  ),
});

export const dispatchTool: ToolDefinition<typeof dispatchSchema> = {
  name: 'dispatch',
  description: 'Invoke another agent with an objective. Use async for background work, inline to await the result.',
  inputSchema: dispatchSchema,
  execute: async (input, context) => {
    const result = await dispatchAgent({
      agent: input.agent,
      objective: input.objective,
      ...(input.hint ? { hint: input.hint } : {}),
      mode: input.mode === 'inline' ? { kind: 'inline' } : { kind: 'async' },
      chatId: context.chatId,
      caller: context.agent.name,
      ...(context.taskId ? { parentTaskId: context.taskId } : {}),
    });
    if (input.mode === 'async') {
      return `Dispatched ${input.agent} (task: ${result ?? 'unknown'})`;
    }
    return result ?? 'done';
  },
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

export const taskToolset: ToolsetDefinition = {
  name: 'task',
  description: 'Use when you need to dispatch agents, cancel tasks, or list running tasks.',
  tools: [dispatchTool, taskCancelTool, taskListTool],
};
