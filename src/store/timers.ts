import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { log } from "@/logger";
import { settings } from "@/settings";

export const TimerEntrySchema = z.object({
	id: z.string(),
	agentName: z.string(),
	chatId: z.string(),
	objective: z.string(),
	hint: z.string().optional(),
	runAt: z.string(),
	createdBy: z.string(),
	createdAt: z.string(),
});

export type TimerEntry = z.infer<typeof TimerEntrySchema>;

/** In-memory timer store */
const timers = new Map<string, TimerEntry>();
/** Active timeout handles */
const timeouts = new Map<string, ReturnType<typeof setTimeout>>();

function timersPath(): string {
	return path.join(settings.dataDir, "timers.json");
}

/** Persist timers to disk. */
async function persist(): Promise<void> {
	await mkdir(settings.dataDir, { recursive: true });
	await Bun.write(timersPath(), JSON.stringify([...timers.values()], null, 2));
}

/** Callback invoked when a timer fires. Set via setOnTimerFire(). */
let _onTimerFire: ((entry: TimerEntry) => Promise<void>) | null = null;

export function setOnTimerFire(fn: (entry: TimerEntry) => Promise<void>): void {
	_onTimerFire = fn;
}

/** Schedule a timeout for a timer entry. Fires immediately if runAt is past. */
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
		log.info("[timers] timer fired", {
			id: entry.id,
			agentName: entry.agentName,
		});
		_onTimerFire?.(entry).catch((err) =>
			log.error("[timers] fire handler error", {
				id: entry.id,
				error: err instanceof Error ? err.message : String(err),
			}),
		);
	}, delayMs);

	timeouts.set(entry.id, handle);
}

/** Load timers from disk. Call at startup after setOnTimerFire(). */
export async function loadTimers(): Promise<void> {
	try {
		const text = await Bun.file(timersPath()).text();
		const entries = z.array(TimerEntrySchema).parse(JSON.parse(text));
		for (const entry of entries) {
			timers.set(entry.id, entry);
			scheduleTimeout(entry);
		}
		log.info("[timers] loaded", { count: timers.size });
	} catch {
		// No timers file yet
	}
}

/** Add a timer. Persists to disk and schedules the timeout. */
export async function addTimer(entry: TimerEntry): Promise<void> {
	timers.set(entry.id, entry);
	await persist();
	scheduleTimeout(entry);
}

/** Remove a timer by ID. Clears timeout and persists. */
export async function removeTimer(id: string): Promise<boolean> {
	const handle = timeouts.get(id);
	if (handle) clearTimeout(handle);
	timeouts.delete(id);
	const existed = timers.delete(id);
	if (existed) await persist();
	return existed;
}

/** List all pending timers. */
export function listTimers(): TimerEntry[] {
	return [...timers.values()];
}

/** Stop all timeouts. Call on shutdown. */
export function stopAllTimers(): void {
	for (const handle of timeouts.values()) {
		clearTimeout(handle);
	}
	timeouts.clear();
}

/** Clear all timers. Test-only. */
export function _clearTimersForTest(): void {
	stopAllTimers();
	timers.clear();
}
