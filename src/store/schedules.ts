import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import { z } from "zod";
import { log } from "@/logger";
import { settings } from "@/settings";

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

/** In-memory schedule store */
const schedules = new Map<string, ScheduleEntry>();
/** Active Cron instances */
const cronJobs = new Map<string, Cron>();

function schedulesPath(): string {
	return path.join(settings.dataDir, "schedules.json");
}

/** Persist schedules to disk. */
async function persist(): Promise<void> {
	await mkdir(settings.dataDir, { recursive: true });
	await Bun.write(
		schedulesPath(),
		JSON.stringify([...schedules.values()], null, 2),
	);
}

/** Callback invoked when a cron fires. Set via setOnCronFire(). */
let _onCronFire: ((entry: ScheduleEntry) => Promise<void>) | null = null;

export function setOnCronFire(
	fn: (entry: ScheduleEntry) => Promise<void>,
): void {
	_onCronFire = fn;
}

/** Start a cron job for a schedule entry. */
function startCron(entry: ScheduleEntry): void {
	const existing = cronJobs.get(entry.id);
	if (existing) existing.stop();

	const job = new Cron(entry.pattern, { timezone: settings.timezone }, () => {
		log.info("[schedules] cron fired", {
			id: entry.id,
			agentName: entry.agentName,
			pattern: entry.pattern,
		});
		_onCronFire?.(entry).catch((err) =>
			log.error("[schedules] cron handler error", {
				id: entry.id,
				error: err instanceof Error ? err.message : String(err),
			}),
		);
	});

	cronJobs.set(entry.id, job);
}

/** Load schedules from disk. Call at startup. */
export async function loadSchedules(): Promise<void> {
	try {
		const text = await Bun.file(schedulesPath()).text();
		const entries = z.array(ScheduleEntrySchema).parse(JSON.parse(text));
		for (const entry of entries) {
			schedules.set(entry.id, entry);
		}
		log.info("[schedules] loaded", { count: schedules.size });
	} catch {
		// No schedules file yet
	}
}

/** Register a cron schedule. Persists to disk and starts the cron job. */
export async function addSchedule(entry: ScheduleEntry): Promise<void> {
	const existing = cronJobs.get(entry.id);
	if (existing) existing.stop();

	schedules.set(entry.id, entry);
	await persist();
	startCron(entry);
}

/** Remove a schedule by ID. */
export async function removeSchedule(id: string): Promise<boolean> {
	const job = cronJobs.get(id);
	if (job) job.stop();
	cronJobs.delete(id);
	const existed = schedules.delete(id);
	if (existed) await persist();
	return existed;
}

/** List all registered schedules. */
export function getSchedules(): ScheduleEntry[] {
	return [...schedules.values()];
}

/** Start all loaded schedules. Call after loadSchedules() + setOnCronFire(). */
export function startAllSchedules(): void {
	for (const entry of schedules.values()) {
		startCron(entry);
	}
}

/** Stop all cron jobs. */
export function stopAllSchedules(): void {
	for (const job of cronJobs.values()) {
		job.stop();
	}
	cronJobs.clear();
}

/** Find a schedule by agent name and label (for dedup). */
export function findSchedule(
	agentName: string,
	label?: string,
): ScheduleEntry | undefined {
	for (const entry of schedules.values()) {
		if (entry.agentName === agentName && entry.label === label) return entry;
	}
	return undefined;
}

/** Clear all schedules. Test-only. */
export function _clearSchedulesForTest(): void {
	stopAllSchedules();
	schedules.clear();
}
