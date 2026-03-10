import path from 'path';
import { eq } from 'drizzle-orm';
import type { DispatchOptions, TurnContext } from '@/types';
import { db } from '@/db/client';
import { tasks } from '@/db/schema';
import { enqueueJob, scheduleJob } from './queue';
import { runAgent, loadAgentDefinition, agentRegistry } from './agent';
import { assembleContext } from './assemble';
import { config } from '@/config';
import { log } from '@/logger';

const AGENTS_DIR = path.join(import.meta.dir, '..', 'agents');

// Test seam — allows dispatch.test.ts to override agent functions without mock.module,
// which would globally poison @/core/agent for other test files.
let _runAgent = runAgent;
let _loadAgentDefinition = loadAgentDefinition;
/** @internal test-only */ export function _setDispatchSeamsForTest(seams: {
  runAgent?: typeof runAgent;
  loadAgentDefinition?: typeof loadAgentDefinition;
}): void {
  if (seams.runAgent) _runAgent = seams.runAgent;
  if (seams.loadAgentDefinition) _loadAgentDefinition = seams.loadAgentDefinition;
}
/** @internal test-only */ export function _clearDispatchSeamsForTest(): void {
  _runAgent = runAgent;
  _loadAgentDefinition = loadAgentDefinition;
}

/**
 * Unified dispatch primitive — the only way agents invoke other agents.
 *
 * Modes:
 *   inline — runs the agent synchronously in the current process; returns undefined (output via reply tool).
 *   async  — creates a task row and enqueues a pg-boss job; returns the task ID.
 *   cron   — registers a pg-boss schedule for the agent; returns undefined.
 */
export async function dispatch(opts: DispatchOptions): Promise<string | undefined> {
  const { agent: agentName, objective, hint, mode, chatId, caller = 'system', parentTaskId, depth = 0 } = opts;

  if (mode.kind !== 'cron' && depth >= config.dispatch.maxChainDepth) {
    log.warn('[dispatch] max chain depth reached, stopping', { agentName, depth });
    return undefined;
  }

  const dispatchContext: TurnContext['dispatchContext'] = {
    caller,
    objective,
    ...(hint ? { hint } : {}),
    mode,
  };

  if (mode.kind === 'cron') {
    log.info('[dispatch] scheduling cron job', { agentName, schedule: mode.schedule });
    await scheduleJob(agentName, mode.schedule, {
      agentName,
      chatId,
      dispatchContext,
    });
    return undefined;
  }

  // For inline and async: load agent definition
  let def = agentRegistry.get(agentName);
  if (!def) {
    const promptPath = path.join(AGENTS_DIR, `${agentName}.md`);
    def = await _loadAgentDefinition(promptPath);
    agentRegistry.set(def.name, def);
  }

  if (mode.kind === 'inline') {
    log.info('[dispatch] inline dispatch', { agentName, caller, depth });

    const partialTurn: Omit<TurnContext, 'assembled'> = {
      chatId,
      agent: def,
      flags: {},
      dispatchContext,
    };

    const assembled = await assembleContext(partialTurn);
    const turn: TurnContext = { ...partialTurn, assembled };

    await _runAgent(turn, def);
    return undefined;
  }

  // async mode: create task row + enqueue
  const [task] = await db
    .insert(tasks)
    .values({
      chatId,
      objective,
      assignedTo: agentName,
      caller,
      status: 'pending',
      ...(parentTaskId ? { parentTaskId } : {}),
    })
    .returning({ id: tasks.id });

  if (!task) {
    log.error('[dispatch] task insert returned no row', { agentName });
    return undefined;
  }

  log.info('[dispatch] async dispatch', { agentName, caller, taskId: task.id, depth });

  await enqueueJob(
    {
      taskId: task.id,
      agentName,
      chatId,
      dispatchContext,
      depth: depth + 1,
    },
    task.id,
  );

  return task.id;
}

/** Update a task row to 'running' status. */
export async function markTaskRunning(taskId: string): Promise<void> {
  await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId));
}

/** Update a task row to 'done' status. */
export async function markTaskDone(taskId: string): Promise<void> {
  await db.update(tasks).set({ status: 'done', completedAt: new Date() }).where(eq(tasks.id, taskId));
}

/** Update a task row to 'failed' status. */
export async function markTaskFailed(taskId: string): Promise<void> {
  await db.update(tasks).set({ status: 'failed', completedAt: new Date() }).where(eq(tasks.id, taskId));
}
