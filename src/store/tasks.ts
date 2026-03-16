import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { config } from "@/config";
import { log } from "@/logger";

export type TaskStatus =
	| "pending"
	| "running"
	| "done"
	| "failed"
	| "cancelled";

export interface TaskRecord {
	id: string;
	chatId: string;
	objective: string;
	assignedTo?: string;
	caller?: string;
	status: TaskStatus;
	result?: unknown;
	parentTaskId?: string;
	createdAt: string;
	completedAt?: string;
}

function tasksDir(): string {
	return path.join(config.dataDir, "tasks");
}

function statusDir(status: TaskStatus): string {
	return path.join(tasksDir(), status);
}

async function ensureDirs(): Promise<void> {
	for (const s of [
		"pending",
		"running",
		"done",
		"failed",
		"cancelled",
	] as const) {
		await mkdir(statusDir(s), { recursive: true });
	}
}

/** Create a new task. Returns the task ID. */
export async function createTask(task: {
	chatId: string;
	objective: string;
	assignedTo?: string;
	caller?: string;
	parentTaskId?: string;
}): Promise<string> {
	await ensureDirs();
	const id = crypto.randomUUID();
	const record: TaskRecord = {
		id,
		chatId: task.chatId,
		objective: task.objective,
		...(task.assignedTo ? { assignedTo: task.assignedTo } : {}),
		...(task.caller ? { caller: task.caller } : {}),
		status: "pending",
		...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
		createdAt: new Date().toISOString(),
	};
	await Bun.write(
		path.join(statusDir("pending"), `${id}.json`),
		JSON.stringify(record, null, 2),
	);
	return id;
}

/** Move a task between status directories. Atomic on same volume. */
export async function moveTask(
	id: string,
	toStatus: TaskStatus,
	update?: Partial<Pick<TaskRecord, "result" | "completedAt">>,
): Promise<void> {
	await ensureDirs();
	const task = await getTask(id);
	if (!task) {
		log.warn("[tasks] moveTask: task not found", { id, toStatus });
		return;
	}
	const fromDir = statusDir(task.status);
	const toDir = statusDir(toStatus);
	const fromPath = path.join(fromDir, `${id}.json`);
	const toPath = path.join(toDir, `${id}.json`);

	const updated: TaskRecord = {
		...task,
		status: toStatus,
		...(update?.result !== undefined ? { result: update.result } : {}),
		...(update?.completedAt ? { completedAt: update.completedAt } : {}),
	};

	// Write updated record to destination, then remove source
	await Bun.write(toPath, JSON.stringify(updated, null, 2));
	try {
		const { unlink } = await import("node:fs/promises");
		await unlink(fromPath);
	} catch {
		// Source may have already been moved — ignore
	}
}

/** Get a task by ID. Scans all status directories. */
export async function getTask(id: string): Promise<TaskRecord | null> {
	for (const status of [
		"pending",
		"running",
		"done",
		"failed",
		"cancelled",
	] as const) {
		const filePath = path.join(statusDir(status), `${id}.json`);
		try {
			const text = await Bun.file(filePath).text();
			return JSON.parse(text) as TaskRecord;
		} catch {
			// Not in this directory
		}
	}
	return null;
}

/** List tasks, optionally filtered by status. */
export async function listTasks(filter?: {
	status?: TaskStatus | TaskStatus[];
	chatId?: string;
}): Promise<TaskRecord[]> {
	await ensureDirs();
	const statuses: TaskStatus[] = filter?.status
		? Array.isArray(filter.status)
			? filter.status
			: [filter.status]
		: ["pending", "running", "done", "failed", "cancelled"];

	const results: TaskRecord[] = [];
	for (const status of statuses) {
		const dir = statusDir(status);
		let files: string[];
		try {
			files = await readdir(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			try {
				const text = await Bun.file(path.join(dir, file)).text();
				const task = JSON.parse(text) as TaskRecord;
				if (filter?.chatId && task.chatId !== filter.chatId) continue;
				results.push(task);
			} catch {
				// Skip corrupt files
			}
		}
	}

	// Sort by createdAt descending
	results.sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);
	return results;
}

/**
 * Crash recovery: move all running tasks back to pending.
 * Call once at startup.
 */
export async function recoverRunningTasks(): Promise<void> {
	await ensureDirs();
	const runningDir = statusDir("running");
	const pendingDir = statusDir("pending");
	let files: string[];
	try {
		files = await readdir(runningDir);
	} catch {
		return;
	}
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			const fromPath = path.join(runningDir, file);
			const text = await Bun.file(fromPath).text();
			const task = JSON.parse(text) as TaskRecord;
			task.status = "pending";
			await Bun.write(
				path.join(pendingDir, file),
				JSON.stringify(task, null, 2),
			);
			const { unlink } = await import("node:fs/promises");
			await unlink(fromPath);
			log.info("[tasks] recovered running task", { id: task.id });
		} catch (err) {
			log.warn("[tasks] failed to recover task", {
				file,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
