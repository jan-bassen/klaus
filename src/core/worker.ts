import path from 'path';
import type PgBoss from 'pg-boss';
import { getQueue } from './queue';
import { runAgent, loadAgentDefinition, agentRegistry } from './agent';
import type { AgentRunPayload } from './queue';
import type { TurnContext, AsyncAgentInvocation, AssembledContext } from '@/types';

const AGENTS_DIR = path.join(import.meta.dir, '..', 'agents');

const EMPTY_ASSEMBLED: AssembledContext = {
  vars: {},
  totalTokens: 0,
};

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

    const { agentName, input } = job.data;

    let def = agentRegistry.get(agentName);
    if (!def) {
      const promptPath = path.join(AGENTS_DIR, `${agentName}.md`);
      def = await loadAgentDefinition(promptPath);
      agentRegistry.set(def.name, def);
    }

    const msg: AsyncAgentInvocation = {
      kind: 'async',
      id: job.id,
      taskId: job.data.taskId,
      input,
    };

    const turn: TurnContext = {
      msg,
      agent: def,
      flags: {},
      assembled: EMPTY_ASSEMBLED,
    };

    await runAgent(turn, def);
  });
}
