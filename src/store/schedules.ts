import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "@/config";
import { log } from "@/logger";
import { ScheduleEntrySchema } from "./schemas";

export interface ScheduleEntry {
	name: string;
	agentName: string;
	pattern: string;
	chatId: string;
	payload: Record<string, unknown>;
	createdAt: string;
}

/** In-memory schedule store */
const schedules = new Map<string, ScheduleEntry>();
/** Active interval handles */
const intervals = new Map<string, ReturnType<typeof setInterval>>();

function schedulesPath(): string {
	return path.join(config.dataDir, "schedules.json");
}

/** Persist schedules to disk. */
async function persist(): Promise<void> {
	await mkdir(config.dataDir, { recursive: true });
	await Bun.write(
		schedulesPath(),
		JSON.stringify([...schedules.values()], null, 2),
	);
}

/** Load schedules from disk. Call at startup. */
export async function loadSchedules(): Promise<void> {
	try {
		const text = await Bun.file(schedulesPath()).text();
		const entries = z.array(ScheduleEntrySchema).parse(JSON.parse(text));
		for (const entry of entries) {
			schedules.set(entry.name, entry);
		}
		log.info("[schedules] loaded", { count: schedules.size });
	} catch {
		// No schedules file yet
	}
}

function matchesCron(pattern: string, date: Date): boolean {
	const parts = pattern.split(/\s+/);
	if (parts.length !== 5) return false;
	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

	const m = date.getUTCMinutes();
	const h = date.getUTCHours();
	const dom = date.getUTCDate();
	const mon = date.getUTCMonth() + 1;
	const dow = date.getUTCDay();

	return (
		matchField(minute ?? "*", m) &&
		matchField(hour ?? "*", h) &&
		matchField(dayOfMonth ?? "*", dom) &&
		matchField(month ?? "*", mon) &&
		matchField(dayOfWeek ?? "*", dow)
	);
}

function matchField(field: string, value: number): boolean {
	if (field === "*") return true;
	// Handle comma-separated values
	for (const part of field.split(",")) {
		if (part.includes("/")) {
			const [, step] = part.split("/");
			if (step && value % Number(step) === 0) return true;
		} else if (Number(part) === value) {
			return true;
		}
	}
	return false;
}

/** Callback invoked when a cron fires. Set by the queue module. */
let _onCronFire: ((entry: ScheduleEntry) => Promise<void>) | null = null;

export function setOnCronFire(
	fn: (entry: ScheduleEntry) => Promise<void>,
): void {
	_onCronFire = fn;
}

/** Start evaluating a schedule. */
function startEvaluating(entry: ScheduleEntry): void {
	// Track last-fired minute to avoid double-firing
	let lastFired = "";

	const handle = setInterval(() => {
		const now = new Date();
		const minuteKey = now.toISOString().slice(0, 16);
		if (minuteKey === lastFired) return;

		if (matchesCron(entry.pattern, now)) {
			lastFired = minuteKey;
			log.info("[schedules] cron fired", {
				name: entry.name,
				pattern: entry.pattern,
			});
			_onCronFire?.(entry).catch((err) =>
				log.error("[schedules] cron handler error", {
					name: entry.name,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		}
	}, 60_000);

	intervals.set(entry.name, handle);
}

/** Register a cron schedule. Persists to disk and starts evaluation. */
export async function addSchedule(entry: ScheduleEntry): Promise<void> {
	// Remove existing schedule with same name
	const existing = intervals.get(entry.name);
	if (existing) clearInterval(existing);

	schedules.set(entry.name, entry);
	await persist();
	startEvaluating(entry);
}

/** Remove a schedule by name. */
export async function removeSchedule(name: string): Promise<void> {
	const handle = intervals.get(name);
	if (handle) clearInterval(handle);
	intervals.delete(name);
	schedules.delete(name);
	await persist();
}

/** List all registered schedules. */
export function getSchedules(): ScheduleEntry[] {
	return [...schedules.values()];
}

/** Start all loaded schedules. Call after loadSchedules(). */
export function startAllSchedules(): void {
	for (const entry of schedules.values()) {
		startEvaluating(entry);
	}
}

/** Stop all schedule intervals. */
export function stopAllSchedules(): void {
	for (const handle of intervals.values()) {
		clearInterval(handle);
	}
	intervals.clear();
}

/** Clear all schedules. Test-only. */
export function _clearSchedulesForTest(): void {
	stopAllSchedules();
	schedules.clear();
}
