/**
 * Real fs I/O into `makeTmpDir`. Cron firings are exercised by mocking
 * `croner` so we can synchronously invoke the registered callback.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cronInstances = vi.hoisted<{
	list: Array<{
		pattern: string;
		stop: () => void;
		fire: () => void;
	}>;
}>(() => ({ list: [] }));

vi.mock("croner", () => ({
	Cron: class {
		pattern: string;
		callback: () => void;
		stopped = false;
		constructor(pattern: string, _opts: unknown, cb: () => void) {
			this.pattern = pattern;
			this.callback = cb;
			cronInstances.list.push({
				pattern,
				stop: () => {
					this.stopped = true;
				},
				fire: () => cb(),
			});
		}
		stop(): void {
			this.stopped = true;
		}
	},
}));

import { readText, writeData } from "../../../src/infra/runtime.ts";
import {
	addSchedule,
	createScheduleStore,
	findSchedule,
	getSchedules,
	initSchedulesStore,
	removeSchedule,
	type ScheduleEntry,
	setOnCronFire,
	startAllSchedules,
	stopAllSchedules,
} from "../../../src/infra/store/schedules.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

function makeEntry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
	return {
		id: overrides.id ?? crypto.randomUUID(),
		agentName: "fitness",
		pattern: "0 8 * * *",
		objective: "morning check",
		createdBy: "tester",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

beforeEach(() => {
	cronInstances.list.length = 0;
});

describe("infra/store/schedules: add/list/remove", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initSchedulesStore({ dataDir: tmpDir, timezone: "UTC" });
	});

	afterEach(() => {
		stopAllSchedules();
		rmTmpDir(tmpDir);
	});

	it("addSchedule → getSchedules returns the entry", async () => {
		const e = makeEntry();
		await addSchedule(e);
		expect(getSchedules()).toEqual([e]);
	});

	it("removeSchedule(id) removes from list and disk; returns true", async () => {
		const e = makeEntry();
		await addSchedule(e);
		expect(await removeSchedule(e.id)).toBe(true);
		expect(getSchedules()).toEqual([]);
		const text = await readText(path.join(tmpDir, "schedules.json"));
		expect(JSON.parse(text)).toEqual([]);
	});

	it("removeSchedule on unknown id returns false", async () => {
		expect(await removeSchedule("nope")).toBe(false);
	});

	it("findSchedule matches exact (agent, label) pair", async () => {
		const a = makeEntry({ agentName: "fitness", label: "morning" });
		const b = makeEntry({ agentName: "fitness", label: "evening" });
		await addSchedule(a);
		await addSchedule(b);
		expect(findSchedule("fitness", "morning")?.id).toBe(a.id);
		expect(findSchedule("fitness", "evening")?.id).toBe(b.id);
		expect(findSchedule("fitness", "nope")).toBeUndefined();
	});

	it("addSchedule stays paused until schedules are started", async () => {
		const e = makeEntry({ pattern: "0 8 * * *" });
		await addSchedule(e);
		expect(cronInstances.list).toHaveLength(0);

		startAllSchedules();
		expect(cronInstances.list).toHaveLength(1);
	});

	it("addSchedule with same id replaces existing + stops old cron when active", async () => {
		const e = makeEntry({ pattern: "0 8 * * *" });
		await addSchedule(e);
		startAllSchedules();

		const replaced = makeEntry({ id: e.id, pattern: "0 9 * * *" });
		await addSchedule(replaced);
		expect(getSchedules()).toEqual([replaced]);
		// First instance should have been stopped (replaced).
		expect(cronInstances.list).toHaveLength(2);
	});
});

describe("infra/store/schedules: persistence", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		stopAllSchedules();
		rmTmpDir(tmpDir);
	});

	it("schedules.json written on add as JSON array of ScheduleEntry", async () => {
		initSchedulesStore({ dataDir: tmpDir, timezone: "UTC" });
		const e = makeEntry();
		await addSchedule(e);
		const file = path.join(tmpDir, "schedules.json");
		expect(existsSync(file)).toBe(true);
		expect(JSON.parse(await readText(file))).toEqual([e]);
	});

	it("load reads file into memory across store reinit", async () => {
		const first = createScheduleStore({ dataDir: tmpDir, timezone: "UTC" });
		const e = makeEntry();
		await first.add(e);
		first.stopAll();

		const second = createScheduleStore({ dataDir: tmpDir, timezone: "UTC" });
		await second.load();
		expect(second.list()).toEqual([e]);
		second.stopAll();
	});

	it("corrupt schedules.json: load swallows + starts empty", async () => {
		await writeData(path.join(tmpDir, "schedules.json"), "{not json");
		const store = createScheduleStore({ dataDir: tmpDir, timezone: "UTC" });
		await store.load();
		expect(store.list()).toEqual([]);
	});
});

describe("infra/store/schedules: cron firing", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initSchedulesStore({ dataDir: tmpDir, timezone: "UTC" });
	});

	afterEach(() => {
		stopAllSchedules();
		rmTmpDir(tmpDir);
	});

	it("setOnCronFire then addSchedule: callback fires with entry", async () => {
		const fired: ScheduleEntry[] = [];
		setOnCronFire(async (e) => {
			fired.push(e);
		});
		const e = makeEntry();
		await addSchedule(e);
		startAllSchedules();
		expect(cronInstances.list).toHaveLength(1);
		cronInstances.list[0]?.fire();
		// fire() invokes the on-fire handler synchronously, but the chain through
		// setOnFire is async — let microtasks flush.
		await Promise.resolve();
		expect(fired).toEqual([e]);
	});

	it("onFire handler throwing is caught (cron survives)", async () => {
		setOnCronFire(async () => {
			throw new Error("boom");
		});
		const e = makeEntry();
		await addSchedule(e);
		startAllSchedules();
		expect(() => cronInstances.list[0]?.fire()).not.toThrow();
	});
});
