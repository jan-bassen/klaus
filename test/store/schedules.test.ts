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
} from "vitest";
import {
	addSchedule,
	findSchedule,
	getSchedules,
	loadSchedules,
	removeSchedule,
} from "@/store/schedules";
import { installTestServices } from "../helpers/services";

let tmpDir: string;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "schedules-test-"));
});

afterAll(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
	installTestServices({ dataDir: tmpDir });
});

describe("addSchedule / getSchedules", () => {
	test("adds and lists a schedule", async () => {
		await addSchedule({
			id: "s-1",
			agentName: "morning",
			pattern: "0 8 * * *",
			chatId: "chat-1",
			objective: "Morning check",
			label: "morning-check",
			createdBy: "klaus",
			createdAt: new Date().toISOString(),
		});

		const schedules = getSchedules();
		expect(schedules).toHaveLength(1);
		expect(schedules[0]?.agentName).toBe("morning");
	});
});

describe("removeSchedule", () => {
	test("removes an existing schedule", async () => {
		await addSchedule({
			id: "s-2",
			agentName: "test",
			pattern: "0 9 * * *",
			chatId: "c",
			objective: "Test",
			createdBy: "system",
			createdAt: new Date().toISOString(),
		});

		const removed = await removeSchedule("s-2");
		expect(removed).toBe(true);
		expect(getSchedules()).toHaveLength(0);
	});

	test("returns false for non-existent schedule", async () => {
		const removed = await removeSchedule("non-existent");
		expect(removed).toBe(false);
	});
});

describe("findSchedule", () => {
	test("finds schedule by agent name and label", async () => {
		await addSchedule({
			id: "s-3",
			agentName: "fitness",
			pattern: "0 7 * * *",
			chatId: "c",
			objective: "Workout",
			label: "daily-workout",
			createdBy: "system",
			createdAt: new Date().toISOString(),
		});

		const found = findSchedule("fitness", "daily-workout");
		expect(found?.id).toBe("s-3");
	});

	test("returns undefined when not found", () => {
		const found = findSchedule("nonexistent");
		expect(found).toBeUndefined();
	});
});

describe("persistence", () => {
	test("schedules persist through save/load cycle", async () => {
		await addSchedule({
			id: "s-4",
			agentName: "italian",
			pattern: "0 10,14,18 * * 1-5",
			chatId: "chat-1",
			objective: "Vocab quiz",
			hint: "Focus on irregular verbs",
			label: "vocab-quiz",
			createdBy: "klaus",
			createdAt: new Date().toISOString(),
		});

		// Fresh services pointing at the same dataDir — load should repopulate.
		installTestServices({ dataDir: tmpDir });
		await loadSchedules();

		const loaded = getSchedules();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.agentName).toBe("italian");
		expect(loaded[0]?.hint).toBe("Focus on irregular verbs");
		expect(loaded[0]?.pattern).toBe("0 10,14,18 * * 1-5");
	});
});

describe("multiple schedules per agent", () => {
	test("allows multiple schedules for the same agent", async () => {
		await addSchedule({
			id: "s-5a",
			agentName: "fitness",
			pattern: "0 7 * * *",
			chatId: "c",
			objective: "Morning workout",
			label: "morning",
			createdBy: "system",
			createdAt: new Date().toISOString(),
		});

		await addSchedule({
			id: "s-5b",
			agentName: "fitness",
			pattern: "0 18 * * *",
			chatId: "c",
			objective: "Evening workout",
			label: "evening",
			createdBy: "system",
			createdAt: new Date().toISOString(),
		});

		expect(getSchedules()).toHaveLength(2);
	});
});
