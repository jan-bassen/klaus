/**
 * Real fs I/O into `makeTmpDir`. Real `setTimeout` with short delays so we
 * don't fight runtime timer semantics under `vi.useFakeTimers()`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readText, writeData } from "../../../src/infra/runtime.ts";
import {
	addTimer,
	createTimerStore,
	initTimersStore,
	listTimers,
	removeTimer,
	stopAllTimers,
	type TimerEntry,
} from "../../../src/infra/store/timers.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

function makeEntry(overrides: Partial<TimerEntry> = {}): TimerEntry {
	return {
		id: overrides.id ?? crypto.randomUUID(),
		agentName: "test",
		objective: "do thing",
		runAt: new Date(Date.now() + 60_000).toISOString(),
		createdBy: "tester",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

const NODE_MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

describe("infra/store/timers: add/list/remove", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initTimersStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		stopAllTimers();
		rmTmpDir(tmpDir);
	});

	it("addTimer → listTimers includes the entry", async () => {
		const e = makeEntry();
		await addTimer(e);
		expect(listTimers()).toEqual([e]);
	});

	it("removeTimer(id) before fire: returns true, entry gone, disk updated", async () => {
		const e = makeEntry();
		await addTimer(e);
		const removed = await removeTimer(e.id);
		expect(removed).toBe(true);
		expect(listTimers()).toEqual([]);

		const text = await readText(path.join(tmpDir, "timers.json"));
		expect(JSON.parse(text)).toEqual([]);
	});

	it("removeTimer on unknown id returns false", async () => {
		expect(await removeTimer("nope")).toBe(false);
	});
});

describe("infra/store/timers: firing", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initTimersStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		stopAllTimers();
		rmTmpDir(tmpDir);
	});

	it("fires once and self-deletes from list + disk", async () => {
		const store = createTimerStore({ dataDir: tmpDir });
		const fired: TimerEntry[] = [];
		store.setOnFire(async (e) => {
			fired.push(e);
		});

		const e = makeEntry({ runAt: new Date(Date.now() + 10).toISOString() });
		await store.add(e);
		store.startAll();
		expect(store.list()).toHaveLength(1);

		await new Promise((r) => setTimeout(r, 60));
		// Allow the post-fire persist() to settle.
		await new Promise((r) => setTimeout(r, 30));

		expect(fired).toEqual([e]);
		expect(store.list()).toEqual([]);

		const text = await readText(path.join(tmpDir, "timers.json"));
		expect(JSON.parse(text)).toEqual([]);
	});

	it("runAt in the past: still fires (delay clamped to 0)", async () => {
		const store = createTimerStore({ dataDir: tmpDir });
		const fired: TimerEntry[] = [];
		store.setOnFire(async (e) => {
			fired.push(e);
		});

		const e = makeEntry({ runAt: new Date(Date.now() - 10_000).toISOString() });
		await store.add(e);
		store.startAll();

		await new Promise((r) => setTimeout(r, 30));
		expect(fired).toEqual([e]);
	});

	it("caps each timeout hop at Node's maximum delay", async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const store = createTimerStore({ dataDir: tmpDir });
		const e = makeEntry({
			runAt: new Date(
				Date.now() + NODE_MAX_TIMEOUT_DELAY_MS + 5_000,
			).toISOString(),
		});

		try {
			await store.add(e);
			store.startAll();

			expect(setTimeoutSpy).toHaveBeenCalledWith(
				expect.any(Function),
				NODE_MAX_TIMEOUT_DELAY_MS,
			);
			expect(store.list()).toEqual([e]);
		} finally {
			store.stopAll();
			setTimeoutSpy.mockRestore();
		}
	});

	it("does not fire before timers are started", async () => {
		const store = createTimerStore({ dataDir: tmpDir });
		const fired: TimerEntry[] = [];
		store.setOnFire(async (e) => {
			fired.push(e);
		});

		await store.add(
			makeEntry({ runAt: new Date(Date.now() + 10).toISOString() }),
		);

		await new Promise((r) => setTimeout(r, 40));
		expect(fired).toEqual([]);
		store.stopAll();
	});

	it("stopAll cancels pending timers (no fire)", async () => {
		const store = createTimerStore({ dataDir: tmpDir });
		const fired: TimerEntry[] = [];
		store.setOnFire(async (e) => {
			fired.push(e);
		});

		await store.add(
			makeEntry({ runAt: new Date(Date.now() + 20).toISOString() }),
		);
		store.startAll();
		store.stopAll();

		await new Promise((r) => setTimeout(r, 50));
		expect(fired).toEqual([]);
	});
});

describe("infra/store/timers: persistence + reload", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		stopAllTimers();
		rmTmpDir(tmpDir);
	});

	it("timers.json written after add; readable JSON array of TimerEntry", async () => {
		initTimersStore({ dataDir: tmpDir });
		const e = makeEntry();
		await addTimer(e);

		const file = path.join(tmpDir, "timers.json");
		expect(existsSync(file)).toBe(true);
		const parsed = JSON.parse(await readText(file));
		expect(parsed).toEqual([e]);
	});

	it("load on a fresh store restores entries and starts them on demand", async () => {
		const first = createTimerStore({ dataDir: tmpDir });
		const e = makeEntry({ runAt: new Date(Date.now() + 30).toISOString() });
		await first.add(e);

		const second = createTimerStore({ dataDir: tmpDir });
		const fired: TimerEntry[] = [];
		second.setOnFire(async (entry) => {
			fired.push(entry);
		});
		await second.load();
		expect(second.list()).toEqual([e]);

		second.startAll();
		await new Promise((r) => setTimeout(r, 80));
		expect(fired).toHaveLength(1);
		expect(fired[0]?.id).toBe(e.id);

		second.stopAll();
	});

	it("missing/corrupt timers.json: load swallows and starts empty", async () => {
		await writeData(path.join(tmpDir, "timers.json"), "{not json");
		const store = createTimerStore({ dataDir: tmpDir });
		await store.load();
		expect(store.list()).toEqual([]);
	});
});
