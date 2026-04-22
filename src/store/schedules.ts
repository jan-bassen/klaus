import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import { z } from "zod";
import { log } from "@/logger";
import { getServices, type ScheduleStore } from "@/services";

export const ScheduleEntrySchema = z.object({
	id: z.string(),
	agentName: z.string(),
	pattern: z.string(),
	chatId: z.string(),
	objective: z.string(),
	hint: z.string().optional(),
	label: z.string().optional(),
	createdBy: z.string(),
	createdAt: z.string(),
});

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;

export interface ScheduleStoreEnv {
	dataDir: string;
	timezone: string;
}

export function createScheduleStore(env: ScheduleStoreEnv): ScheduleStore {
	const schedules = new Map<string, ScheduleEntry>();
	const cronJobs = new Map<string, Cron>();
	let onFire: ((entry: ScheduleEntry) => Promise<void>) | null = null;

	const schedulesPath = (): string => path.join(env.dataDir, "schedules.json");

	async function persist(): Promise<void> {
		await mkdir(env.dataDir, { recursive: true });
		await Bun.write(
			schedulesPath(),
			JSON.stringify([...schedules.values()], null, 2),
		);
	}

	function startCron(entry: ScheduleEntry): void {
		const existing = cronJobs.get(entry.id);
		if (existing) existing.stop();

		const job = new Cron(entry.pattern, { timezone: env.timezone }, () => {
			log.info(`[schedules] cron fired for @${entry.agentName}`);
			onFire?.(entry).catch((err) =>
				log.error("[schedules] cron handler error", {
					id: entry.id,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		});

		cronJobs.set(entry.id, job);
	}

	async function load(): Promise<void> {
		try {
			const text = await Bun.file(schedulesPath()).text();
			const entries = z.array(ScheduleEntrySchema).parse(JSON.parse(text));
			for (const entry of entries) {
				schedules.set(entry.id, entry);
			}
			log.info(`[schedules] loaded (${schedules.size} schedules)`);
		} catch {
			// No schedules file yet
		}
	}

	async function add(entry: ScheduleEntry): Promise<void> {
		const existing = cronJobs.get(entry.id);
		if (existing) existing.stop();

		schedules.set(entry.id, entry);
		await persist();
		startCron(entry);
	}

	async function remove(id: string): Promise<boolean> {
		const job = cronJobs.get(id);
		if (job) job.stop();
		cronJobs.delete(id);
		const existed = schedules.delete(id);
		if (existed) await persist();
		return existed;
	}

	function list(): ScheduleEntry[] {
		return [...schedules.values()];
	}

	function startAll(): void {
		for (const entry of schedules.values()) {
			startCron(entry);
		}
	}

	function stopAll(): void {
		for (const job of cronJobs.values()) {
			job.stop();
		}
		cronJobs.clear();
	}

	function find(agentName: string, label?: string): ScheduleEntry | undefined {
		for (const entry of schedules.values()) {
			if (entry.agentName === agentName && entry.label === label) return entry;
		}
		return undefined;
	}

	return {
		setOnFire: (fn) => {
			onFire = fn;
		},
		load,
		add,
		remove,
		list,
		startAll,
		stopAll,
		find,
	};
}

// Module-level delegators — preserve existing public API, route to registered instance.

export function setOnCronFire(
	fn: (entry: ScheduleEntry) => Promise<void>,
): void {
	getServices().schedules.setOnFire(fn);
}

export function loadSchedules(): Promise<void> {
	return getServices().schedules.load();
}

export function addSchedule(entry: ScheduleEntry): Promise<void> {
	return getServices().schedules.add(entry);
}

export function removeSchedule(id: string): Promise<boolean> {
	return getServices().schedules.remove(id);
}

export function getSchedules(): ScheduleEntry[] {
	return getServices().schedules.list();
}

export function startAllSchedules(): void {
	getServices().schedules.startAll();
}

export function stopAllSchedules(): void {
	getServices().schedules.stopAll();
}

export function findSchedule(
	agentName: string,
	label?: string,
): ScheduleEntry | undefined {
	return getServices().schedules.find(agentName, label);
}
