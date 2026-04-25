/**
 * `infra/store/timers.ts` — one-shot persistence + firing.
 *
 * Real fs I/O into `makeTmpDir`; use `vi.useFakeTimers()` to drive timer
 * firings without real-time waits. Each test should restore real timers in
 * afterEach.
 *
 * Key invariants:
 *   - Timers fire exactly once and self-delete from memory + disk.
 *   - `load()` re-schedules remaining timers with a delay relative to NOW
 *     (handles `runAt` in the past → fires immediately with delay clamped to 0).
 *   - Remove before fire cancels cleanly.
 */

import { afterEach, beforeEach, describe, it } from "vitest";

// import {
//   initTimersStore, loadTimers, addTimer, removeTimer, listTimers,
//   setOnTimerFire, stopAllTimers,
// } from "@/infra/store/timers";
// import { makeTmpDir, rmTmpDir } from "../../helpers/tmp";

describe("infra/store/timers: add/list/remove", () => {
	let tmpDir: string;

	beforeEach(() => {
		// vi.useFakeTimers(); tmpDir = makeTmpDir();
		// initTimersStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		// stopAllTimers(); vi.useRealTimers(); rmTmpDir(tmpDir);
	});

	it.todo("addTimer → listTimers includes the entry");

	it.todo(
		"removeTimer(id) before fire: returns true, entry gone, disk updated",
	);

	it.todo("removeTimer on unknown id returns false");
});

describe("infra/store/timers: firing", () => {
	it.todo(
		"setOnTimerFire + addTimer with runAt=now+5s: advance 5s → callback fires once",
	);

	it.todo("after fire: entry removed from listTimers AND from timers.json");

	it.todo("runAt in the past: fires on the next tick (delay clamped to 0)");

	it.todo("stopAllTimers: pending timers do NOT fire when advanced past runAt");

	it.todo(
		"removeTimer on a fired-and-self-deleted id returns false (idempotent)",
	);

	it.todo("onFire handler throwing is caught + logged (no uncaught rejection)");
});

describe("infra/store/timers: persistence + reload", () => {
	it.todo("timers.json written after add; valid JSON array of TimerEntry");

	it.todo(
		"loadTimers on a fresh store restores entries AND re-schedules timeouts",
	);

	it.todo("corrupt timers.json: load swallows + starts empty");
});
