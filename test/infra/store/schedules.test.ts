/**
 * `infra/store/schedules.ts` — cron persistence + firing.
 *
 * Uses real file I/O into `makeTmpDir`. Croner's `Cron` runs in-process — use
 * short patterns (e.g. `* * * * * *` with seconds) AND `setOnFire` to observe
 * firings via a spy. Stop the job with `removeSchedule` or `stopAll` in
 * afterEach so stray timers don't leak between tests.
 *
 * Alternative: mock `croner` entirely with `vi.mock("croner", ...)` exposing a
 * fake `Cron` class whose constructor stashes the callback — then you can
 * invoke it synchronously and avoid real-time waits.
 */

import { afterEach, beforeEach, describe, it } from "vitest";

// import {
//   initSchedulesStore, loadSchedules, addSchedule, removeSchedule,
//   getSchedules, setOnCronFire, startAllSchedules, stopAllSchedules,
//   findSchedule,
// } from "@/infra/store/schedules";
// import { makeTmpDir, rmTmpDir } from "../../helpers/tmp";

describe("infra/store/schedules: add/list/remove", () => {
	let tmpDir: string;

	beforeEach(() => {
		// tmpDir = makeTmpDir();
		// initSchedulesStore({ dataDir: tmpDir, timezone: "UTC" });
	});

	afterEach(() => {
		// stopAllSchedules(); rmTmpDir(tmpDir);
	});

	it.todo(
		"addSchedule → getSchedules returns the entry",
	);

	it.todo(
		"removeSchedule(id) removes from list and disk; returns true",
	);

	it.todo(
		"removeSchedule on unknown id returns false (no throw, no disk write)",
	);

	it.todo(
		"findSchedule(agent, label?) matches exact (agent,label) pair",
	);

	it.todo(
		"addSchedule with same id replaces existing + stops old cron",
	);
});

describe("infra/store/schedules: persistence", () => {
	it.todo(
		"schedules.json written on add; valid JSON array of ScheduleEntry",
	);

	it.todo(
		"loadSchedules reads the file into memory (survives store re-init)",
	);

	it.todo(
		"corrupt schedules.json: load swallows the error (no throw) and starts with empty map",
	);
});

describe("infra/store/schedules: cron firing", () => {
	it.todo(
		"setOnCronFire then addSchedule: callback fires on pattern match with the entry",
	);

	it.todo(
		"multiple schedules fire independently",
	);

	it.todo(
		"stopAllSchedules halts all running crons",
	);

	it.todo(
		"startAllSchedules after load re-registers crons for persisted entries",
	);

	it.todo(
		"onFire handler throwing is caught + logged (doesn't kill the cron)",
	);
});
