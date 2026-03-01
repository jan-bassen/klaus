import PgBoss from 'pg-boss';

export type JobName = 'agent-run' | 'scheduled-hook';

export interface AgentRunPayload {
  taskId: string;
  agentName: string;
  input: unknown;
}

let boss: PgBoss | null = null;

export async function initQueue(): Promise<PgBoss> {
  throw new Error('TODO: not implemented');
}

export function getQueue(): PgBoss {
  if (!boss) throw new Error('Queue not initialized — call initQueue() first');
  return boss;
}

/** Enqueue an agent run job for a given task. jobId provides idempotency. */
export async function dispatch(
  _name: JobName,
  _payload: AgentRunPayload,
  _jobId: string,
): Promise<void> {
  throw new Error('TODO: not implemented');
}
