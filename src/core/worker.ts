import path from 'path';
import type PgBoss from 'pg-boss';
import { getQueue } from './queue';
import { runAgent, loadAgentDefinition, agentRegistry } from './agent';
import { assembleContext } from './assemble';
import { markTaskRunning, markTaskDone, markTaskFailed } from './dispatch';
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
}
