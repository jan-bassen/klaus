import path from 'path';
import type PgBoss from 'pg-boss';
import { getQueue } from './queue';
import { runAgent, loadAgentDefinition, agentRegistry } from './agent';
import type { AgentRunPayload } from './queue';
import type { TurnContext, InboundMessage, AssembledContext } from '@/types';

const AGENTS_DIR = path.join(import.meta.dir, '..', 'agents');

const EMPTY_ASSEMBLED: AssembledContext = {
  conversation: '',
  graphContext: '',
  activeTasks: '',
  toolDescriptions: '',
  flagInjections: '',
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

    // Synthetic InboundMessage for async task context
    const msg: InboundMessage = {
      id: job.id,
      chatId: 'async-task',
      senderId: 'system',
      text: typeof input === 'string' ? input : JSON.stringify(input),
      timestamp: new Date(),
      messageKey: {},
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
