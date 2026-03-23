import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let savedDataDir: string | undefined;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "timers-test-"));
	savedDataDir = process.env.DATA_DIR;
	process.env.DATA_DIR = tmpDir;
});

afterAll(async () => {
	if (savedDataDir !== undefined) process.env.DATA_DIR = savedDataDir;
	else delete process.env.DATA_DIR;
	await rm(tmpDir, { recursive: true, force: true });
});

const {
	addTimer,
	removeTimer,
	listTimers,
	loadTimers,
	setOnTimerFire,
	_clearTimersForTest,
} = await import("@/store/timers");

afterEach(() => {
	_clearTimersForTest();
});

describe("addTimer / listTimers", () => {
	test("adds a timer and lists it", async () => {
		await addTimer({
			id: "t-1",
			agentName: "klaus",
			chatId: "chat-1",
			objective: "Remind Jan",
			runAt: new Date(Date.now() + 60_000).toISOString(),
			createdBy: "klaus",
			createdAt: new Date().toISOString(),
		});

		const timers = listTimers();
		expect(timers).toHaveLength(1);
		expect(timers[0]?.objective).toBe("Remind Jan");
	});
});

describe("removeTimer", () => {
	test("removes an existing timer", async () => {
		await addTimer({
			id: "t-2",
			agentName: "klaus",
			chatId: "chat-1",
			objective: "Check in",
			runAt: new Date(Date.now() + 60_000).toISOString(),
			createdBy: "klaus",
			createdAt: new Date().toISOString(),
		});

		const removed = await removeTimer("t-2");
		expect(removed).toBe(true);
		expect(listTimers()).toHaveLength(0);
	});

	test("returns false for non-existent timer", async () => {
		const removed = await removeTimer("non-existent");
		expect(removed).toBe(false);
	});
});

describe("persistence", () => {
	test("timers persist through save/load cycle", async () => {
		await addTimer({
			id: "t-3",
			agentName: "fitness",
			chatId: "chat-1",
			objective: "Workout reminder",
			hint: "Do push-ups",
			runAt: new Date(Date.now() + 3_600_000).toISOString(),
			createdBy: "fitness",
			createdAt: new Date().toISOString(),
		});

		_clearTimersForTest();
		await loadTimers();

		const loaded = listTimers();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.objective).toBe("Workout reminder");
		expect(loaded[0]?.hint).toBe("Do push-ups");
	});
});

describe("timer firing", () => {
	test("fires callback for past runAt", async () => {
		const fired = mock(() => Promise.resolve());
		setOnTimerFire(fired);

		await addTimer({
			id: "t-past",
			agentName: "klaus",
			chatId: "chat-1",
			objective: "Should fire immediately",
			runAt: new Date(Date.now() - 1_000).toISOString(),
			createdBy: "klaus",
			createdAt: new Date().toISOString(),
		});

		// setTimeout(0) fires on next tick
		await new Promise((r) => setTimeout(r, 50));
		expect(fired).toHaveBeenCalledTimes(1);
		expect(listTimers()).toHaveLength(0);
	});
});
