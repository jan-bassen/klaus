import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import {
	addTimer,
	listTimers,
	loadTimers,
	removeTimer,
	setOnTimerFire,
} from "@/store/timers";
import { installTestServices } from "../helpers/services";

let tmpDir: string;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "timers-test-"));
});

afterAll(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
	installTestServices({ dataDir: tmpDir });
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

		// Fresh services pointing at the same dataDir — timers start empty,
		// loadTimers() should repopulate from disk.
		installTestServices({ dataDir: tmpDir });
		await loadTimers();

		const loaded = listTimers();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.objective).toBe("Workout reminder");
		expect(loaded[0]?.hint).toBe("Do push-ups");
	});
});

describe("timer firing", () => {
	test("fires callback for past runAt", async () => {
		const fired = vi.fn(() => Promise.resolve());
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

		await new Promise((r) => setTimeout(r, 50));
		expect(fired).toHaveBeenCalledTimes(1);
		expect(listTimers()).toHaveLength(0);
	});
});
