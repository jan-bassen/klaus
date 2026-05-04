import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { log } from "../logger.ts";

import { readText, writeData } from "../runtime.ts";

interface TimerStore {
	setOnFire(fn: (entry: TimerEntry) => Promise<void>): void;
	load(): Promise<void>;
	add(entry: TimerEntry): Promise<void>;
	remove(id: string): Promise<boolean>;
	list(): TimerEntry[];
	stopAll(): void;
}

const TimerEntrySchema = z.object({
	id: z.string(),
	agentName: z.string(),
	chatId: z.string(),
	objective: z.string(),
	overrides: z.array(z.string()).optional(),
	runAt: z.string(),
	createdBy: z.string(),
	createdAt: z.string(),
});

export type TimerEntry = z.infer<typeof TimerEntrySchema>;

interface TimerStoreEnv {
	dataDir: string;
}

export function createTimerStore(env: TimerStoreEnv): TimerStore {
	const timers = new Map<string, TimerEntry>();
	const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
	let onFire: ((entry: TimerEntry) => Promise<void>) | null = null;

	const timersPath = (): string => path.join(env.dataDir, "timers.json");

	async function persist(): Promise<void> {
		await mkdir(env.dataDir, { recursive: true });
		await writeData(
			timersPath(),
			JSON.stringify([...timers.values()], null, 2),
		);
	}

	function scheduleTimeout(entry: TimerEntry): void {
		const existing = timeouts.get(entry.id);
		if (existing) clearTimeout(existing);

		const delayMs = Math.max(0, new Date(entry.runAt).getTime() - Date.now());

		const handle = setTimeout(() => {
			timeouts.delete(entry.id);
			timers.delete(entry.id);
			persist().catch((err) =>
				log.error("[timers] persist error after fire", {
					id: entry.id,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
			log.info(`[timers] fired for @${entry.agentName}`);
			onFire?.(entry).catch((err) =>
				log.error("[timers] fire handler error", {
					id: entry.id,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		}, delayMs);

		timeouts.set(entry.id, handle);
	}

	async function load(): Promise<void> {
		try {
			const text = await readText(timersPath());
			const entries = z.array(TimerEntrySchema).parse(JSON.parse(text));
			for (const entry of entries) {
				timers.set(entry.id, entry);
				scheduleTimeout(entry);
			}
			log.info(`[timers] loaded (${timers.size} timers)`);
		} catch {
			// No timers file yet
		}
	}

	async function add(entry: TimerEntry): Promise<void> {
		timers.set(entry.id, entry);
		await persist();
		scheduleTimeout(entry);
	}

	async function remove(id: string): Promise<boolean> {
		const handle = timeouts.get(id);
		if (handle) clearTimeout(handle);
		timeouts.delete(id);
		const existed = timers.delete(id);
		if (existed) await persist();
		return existed;
	}

	function list(): TimerEntry[] {
		return [...timers.values()];
	}

	function stopAll(): void {
		for (const handle of timeouts.values()) {
			clearTimeout(handle);
		}
		timeouts.clear();
	}

	return {
		setOnFire: (fn) => {
			onFire = fn;
		},
		load,
		add,
		remove,
		list,
		stopAll,
	};
}

// ── Module-level instance + delegators ────────────────────────────────────

let _store: TimerStore | null = null;

export function initTimersStore(env: TimerStoreEnv): void {
	_store = createTimerStore(env);
}

function store(): TimerStore {
	if (!_store) throw new Error("[timers] store not initialized");
	return _store;
}

export function setOnTimerFire(fn: (entry: TimerEntry) => Promise<void>): void {
	store().setOnFire(fn);
}

export function loadTimers(): Promise<void> {
	return store().load();
}

export function addTimer(entry: TimerEntry): Promise<void> {
	return store().add(entry);
}

export function removeTimer(id: string): Promise<boolean> {
	return store().remove(id);
}

export function listTimers(): TimerEntry[] {
	return store().list();
}

export function stopAllTimers(): void {
	store().stopAll();
}
