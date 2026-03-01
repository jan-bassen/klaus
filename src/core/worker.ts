import type PgBoss from 'pg-boss';
import { getQueue } from './queue';
import { runAgent } from './agent';
import type { AgentRunPayload } from './queue';

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
    throw new Error(`TODO: implement worker — job ${job.id}, agent ${job.data.agentName}`);
    void runAgent; // referenced to prevent unused import warning
  });
}
