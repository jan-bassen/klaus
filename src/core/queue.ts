import PgBoss from "pg-boss";
import { config } from "@/config";
import type { DispatchMode } from "@/types";

export type JobName = "agent-run";

export interface AgentRunPayload {
	taskId: string;
	agentName: string;
	chatId: string;
	dispatchContext: {
		caller: string;
		objective: string;
		hint?: string;
		mode: DispatchMode;
	};
	/** Chain depth at the time of enqueue — used to enforce maxChainDepth across async boundaries. */
	depth: number;
}

let boss: PgBoss | null = null;

export async function initQueue(): Promise<PgBoss> {
	const b = new PgBoss(config.database.url);
	await b.start();
	await b.createQueue("agent-run");
	boss = b;
	return b;
}

export function getQueue(): PgBoss {
	if (!boss) throw new Error("Queue not initialized — call initQueue() first");
	return boss;
}

/** Enqueue an agent run job. jobId provides idempotency. */
export async function enqueueJob(
	payload: AgentRunPayload,
	jobId: string,
): Promise<void> {
	await getQueue().send("agent-run", payload, { id: jobId });
}

/** Schedule a recurring agent run via pg-boss cron. */
export async function scheduleJob(
	agentName: string,
	schedule: string,
	payload: Omit<AgentRunPayload, "taskId" | "depth">,
): Promise<void> {
	const q = getQueue();
	// pg-boss v10: schedule.name is a FK to queue.name, so the queue must exist first.
	await q.createQueue(agentName);
	await q.schedule(agentName, schedule, payload);
}

export async function listSchedules(): Promise<unknown[]> {
	return getQueue().getSchedules();
}

export async function deleteSchedule(name: string): Promise<void> {
	await getQueue().unschedule(name);
}

export async function stopQueue(): Promise<void> {
	if (boss) await boss.stop();
}

export function isQueueReady(): boolean {
	return boss !== null;
}
