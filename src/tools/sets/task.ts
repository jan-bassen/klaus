import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ToolDefinition, ToolsetDefinition } from '@/types';
import { dispatch as dispatchAgent } from '@/core/dispatch';
import { db } from '@/db/client';
import { tasks } from '@/db/schema';
import { getQueue } from '@/core/queue';
import { log } from '@/logger';

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
  execute: async (input) => {
    const [task] = await db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(eq(tasks.id, input.taskId));
    if (!task) return `Task ${input.taskId} not found.`;
    if (['done', 'failed', 'cancelled'].includes(task.status)) return `Task already ${task.status}.`;
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, input.taskId));
    try { await getQueue().cancel('agent-run', input.taskId); } catch (err) {
      log.warn('[task.cancel] pg-boss cancel failed', { taskId: input.taskId, error: err instanceof Error ? err.message : String(err) });
    }
    return `Cancelled task ${input.taskId}`;
  },
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
  execute: async (input, context) => {
    const filter = input.status
      ? and(eq(tasks.chatId, context.chatId), eq(tasks.status, input.status))
      : eq(tasks.chatId, context.chatId);
    const rows = await db.select().from(tasks).where(filter).orderBy(desc(tasks.createdAt)).limit(20);
    if (rows.length === 0) return 'No tasks found.';
    return rows.map((t) => `[${t.id}] ${t.assignedTo ?? '?'} — ${t.status}: ${t.objective}`).join('\n');
  },
  kind: 'builtin',
  capability: 'resource',
};

// task.get
const taskGetSchema = z.object({
  taskId: z.string().uuid().describe('Task ID to inspect'),
});

export const taskGetTool: ToolDefinition<typeof taskGetSchema> = {
  name: 'task.get',
  description: 'Fetch the full details of a task by ID, including status, timing, and result.',
  inputSchema: taskGetSchema,
  execute: async (input) => {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, input.taskId));
    if (!task) return `Task ${input.taskId} not found.`;
    const lines = [
      `ID:         ${task.id}`,
      `Status:     ${task.status}`,
      `Agent:      ${task.assignedTo ?? '—'}`,
      `Caller:     ${task.caller ?? '—'}`,
      `Objective:  ${task.objective}`,
      `Parent:     ${task.parentTaskId ?? '—'}`,
      `Created:    ${task.createdAt.toISOString()}`,
      `Completed:  ${task.completedAt?.toISOString() ?? '—'}`,
      `Result:     ${task.result != null ? JSON.stringify(task.result, null, 2) : '—'}`,
    ];
    return lines.join('\n');
  },
  kind: 'builtin',
  capability: 'resource',
};

export const taskToolset: ToolsetDefinition = {
  name: 'task',
  description: 'Use when you need to dispatch agents, cancel tasks, or list running tasks.',
  tools: [dispatchTool, taskCancelTool, taskListTool, taskGetTool],
};
