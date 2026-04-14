import { log } from "@/logger";
import type { DispatchMode } from "./dispatch";

export interface AgentRunPayload {
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

export interface ActiveJob {
	agentName: string;
	objective: string;
	startedAt: string;
}

// -- In-memory job queue --

const pending: AgentRunPayload[] = [];
let processing = false;
let drainHandle: ReturnType<typeof setInterval> | null = null;
let _worker: ((payload: AgentRunPayload) => Promise<void>) | null = null;
let ready = false;

/** Active jobs tracked by a unique key (UUID generated at dequeue time). */
const activeJobs = new Map<string, ActiveJob>();

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

		const jobId = crypto.randomUUID();
		activeJobs.set(jobId, {
			agentName: job.agentName,
			objective: job.dispatchContext.objective,
			startedAt: new Date().toISOString(),
		});

		try {
			await _worker(job);
		} catch (err) {
			log.error(`[queue] job failed for @${job.agentName}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			activeJobs.delete(jobId);
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
export function enqueueJob(payload: AgentRunPayload): void {
	pending.push(payload);
	// Trigger immediate drain
	drain().catch((err) =>
		log.error("[queue] drain error", {
			error: err instanceof Error ? err.message : String(err),
		}),
	);
}

/** Get currently active jobs. */
export function getActiveJobs(): ActiveJob[] {
	return [...activeJobs.values()];
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
