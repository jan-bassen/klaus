import { log } from "@/logger";
import {
	addSchedule,
	getSchedules as getScheduleEntries,
	removeSchedule,
	type ScheduleEntry,
	setOnCronFire,
	startAllSchedules,
} from "@/store/schedules";
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

// -- In-memory job queue --

const pending: AgentRunPayload[] = [];
let processing = false;
let drainHandle: ReturnType<typeof setInterval> | null = null;
let _worker: ((payload: AgentRunPayload) => Promise<void>) | null = null;
let ready = false;

/** Set the worker function that processes jobs. */
export function setWorker(
	fn: (payload: AgentRunPayload) => Promise<void>,
): void {
	_worker = fn;
}

async function drain(): Promise<void> {
	if (processing || pending.length === 0 || !_worker) return;
	processing = true;

	while (pending.length > 0) {
		const job = pending.shift();
		if (!job) break;

		try {
			await _worker(job);
		} catch (err) {
			log.error("[queue] job failed", {
				taskId: job.taskId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	processing = false;
}

/** Initialize the in-memory queue. Starts the drain loop. */
export async function initQueue(): Promise<void> {
	drainHandle = setInterval(drain, 500);
	ready = true;
}

/** Enqueue an agent run job. */
export async function enqueueJob(
	payload: AgentRunPayload,
	_jobId: string,
): Promise<void> {
	pending.push(payload);
	// Trigger immediate drain
	drain().catch((err) =>
		log.error("[queue] drain error", {
			error: err instanceof Error ? err.message : String(err),
		}),
	);
}

/** Schedule a recurring agent run via cron. */
export async function scheduleJob(
	agentName: string,
	schedule: string,
	payload: Omit<AgentRunPayload, "taskId" | "depth">,
): Promise<void> {
	await addSchedule({
		name: agentName,
		agentName,
		pattern: schedule,
		chatId: payload.chatId,
		payload: payload as unknown as Record<string, unknown>,
		createdAt: new Date().toISOString(),
	});
}

export async function listSchedules(): Promise<ScheduleEntry[]> {
	return getScheduleEntries();
}

export async function deleteSchedule(name: string): Promise<void> {
	await removeSchedule(name);
}

export async function stopQueue(): Promise<void> {
	if (drainHandle) {
		clearInterval(drainHandle);
		drainHandle = null;
	}
	ready = false;
}

export function isQueueReady(): boolean {
	return ready;
}

/**
 * Register the cron fire callback — dispatches cron jobs into the queue.
 * Call once at startup after initQueue().
 */
export function registerCronCallback(
	dispatchFn: (entry: ScheduleEntry) => Promise<void>,
): void {
	setOnCronFire(dispatchFn);
	startAllSchedules();
}
