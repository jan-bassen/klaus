import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import { z } from "zod";
import { log } from "../logger.ts";

import { readText, writeData } from "../runtime.ts";

interface ScheduleStore {
	setOnFire(fn: (entry: ScheduleEntry) => Promise<void>): void;
	load(): Promise<void>;
	add(entry: ScheduleEntry): Promise<void>;
	remove(id: string): Promise<boolean>;
	list(): ScheduleEntry[];
	startAll(): void;
	stopAll(): void;
	find(agentName: string, label?: string): ScheduleEntry | undefined;
}

const ScheduleEntrySchema = z.object({
	id: z.string(),
	agentName: z.string(),
	pattern: z.string(),
	objective: z.string(),
	overrides: z.array(z.string()).optional(),
	label: z.string().optional(),
	createdBy: z.string(),
	createdAt: z.string(),
});

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;

interface ScheduleStoreEnv {
	dataDir: string;
	timezone: string;
}

export function createScheduleStore(env: ScheduleStoreEnv): ScheduleStore {
	const schedules = new Map<string, ScheduleEntry>();
	const cronJobs = new Map<string, Cron>();
	let onFire: ((entry: ScheduleEntry) => Promise<void>) | null = null;
	let active = false;

	const schedulesPath = (): string => path.join(env.dataDir, "schedules.json");

	async function persist(): Promise<void> {
		await mkdir(env.dataDir, { recursive: true });
		await writeData(
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
			const text = await readText(schedulesPath());
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
		if (active) startCron(entry);
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
		active = true;
		for (const entry of schedules.values()) {
			startCron(entry);
		}
	}

	function stopAll(): void {
		active = false;
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

// ── Module-level instance + delegators ────────────────────────────────────

let _store: ScheduleStore | null = null;

export function initSchedulesStore(env: ScheduleStoreEnv): void {
	_store = createScheduleStore(env);
}

function store(): ScheduleStore {
	if (!_store) throw new Error("[schedules] store not initialized");
	return _store;
}

export function setOnCronFire(
	fn: (entry: ScheduleEntry) => Promise<void>,
): void {
	store().setOnFire(fn);
}

export function loadSchedules(): Promise<void> {
	return store().load();
}

export function addSchedule(entry: ScheduleEntry): Promise<void> {
	return store().add(entry);
}

export function removeSchedule(id: string): Promise<boolean> {
	return store().remove(id);
}

export function getSchedules(): ScheduleEntry[] {
	return store().list();
}

export function startAllSchedules(): void {
	store().startAll();
}

export function stopAllSchedules(): void {
	store().stopAll();
}

export function findSchedule(
	agentName: string,
	label?: string,
): ScheduleEntry | undefined {
	return store().find(agentName, label);
}
