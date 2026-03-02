import PgBoss from 'pg-boss';

export type JobName = 'agent-run' | 'scheduled-hook';

export interface AgentRunPayload {
  taskId: string;
  agentName: string;
  input: unknown;
}

let boss: PgBoss | null = null;

export async function initQueue(): Promise<PgBoss> {
  const b = new PgBoss(
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/klaus',
  );
  await b.start();
  boss = b;
  return b;
}

export function getQueue(): PgBoss {
  if (!boss) throw new Error('Queue not initialized — call initQueue() first');
  return boss;
}

/** Enqueue an agent run job for a given task. jobId provides idempotency. */
export async function dispatch(
  name: JobName,
  payload: AgentRunPayload,
  jobId: string,
): Promise<void> {
  await getQueue().send(name, payload, { id: jobId });
}
