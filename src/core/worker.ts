import path from 'path';
import type PgBoss from 'pg-boss';
import { getQueue } from './queue';
import { runAgent, loadAgentDefinition, agentRegistry } from './agent';
import { assembleContext } from './assemble';
import { dispatch, markTaskRunning, markTaskDone, markTaskFailed } from './dispatch';
import { log } from '@/logger';
import type { AgentRunPayload } from './queue';
import type { TurnContext } from '@/types';

const AGENTS_DIR = path.join(import.meta.dir, '..', 'agents');

/**
 * Registers pgboss workers for all job types.
 * Called once at startup after initQueue().
 * Workers call agent.ts directly — they do NOT go through pipeline.ts.
 */
export async function startWorkers(): Promise<void> {
  const boss = getQueue();

  await boss.work<AgentRunPayload>('agent-run', async (jobs: PgBoss.Job<AgentRunPayload>[]) => {
    const job = jobs[0];
    if (!job) return;

    const { agentName, taskId, chatId, dispatchContext, depth } = job.data;

    let def = agentRegistry.get(agentName);
    if (!def) {
      const promptPath = path.join(AGENTS_DIR, `${agentName}.md`);
      def = await loadAgentDefinition(promptPath);
      agentRegistry.set(def.name, def);
    }

    // Build partial TurnContext for context assembly
    const partialTurn: Omit<TurnContext, 'assembled'> = {
      chatId,
      taskId,
      agent: def,
      flags: {},
      dispatchContext,
    };

    await markTaskRunning(taskId);

    try {
      const assembled = await assembleContext(partialTurn);
      const turn: TurnContext = { ...partialTurn, assembled };

      log.info('[worker] starting agent', { agentName, taskId, depth });
      await runAgent(turn, def);
      await markTaskDone(taskId);
      log.info('[worker] agent completed', { agentName, taskId });
    } catch (err) {
      await markTaskFailed(taskId);
      log.error('[worker] agent failed', {
        agentName,
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Cron queues: each scheduled agent has its own pg-boss queue (schedule.name is a FK to
  // queue.name). Register a thin worker per queue that re-dispatches into 'agent-run'.
  for (const def of agentRegistry.values()) {
    if (!def.schedule) continue;

    await boss.work<Omit<AgentRunPayload, 'taskId' | 'depth'>>(def.name, async (jobs) => {
      const job = jobs[0];
      if (!job) return;
      const { agentName, chatId, dispatchContext } = job.data;
      log.info('[worker] cron trigger, re-dispatching', { agentName });
      await dispatch({
        agent: agentName,
        objective: dispatchContext.objective,
        ...(dispatchContext.hint ? { hint: dispatchContext.hint } : {}),
        mode: { kind: 'async' },
        chatId,
        caller: 'scheduler',
      });
    });
  }
}
