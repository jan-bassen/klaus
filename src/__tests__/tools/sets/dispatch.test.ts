import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentDefinition, TurnContext } from "@/types";

// ─── mocks ───────────────────────────────────────────────────────────────────

const mockDispatch = mock(async (): Promise<string | undefined> => undefined);
mock.module("@/core/dispatch", () => ({ dispatch: mockDispatch }));

const mockAddSchedule = mock(async () => {});
const mockGetSchedules = mock(() => [] as unknown[]);
const mockRemoveSchedule = mock(async () => false);
const mockFindSchedule = mock(() => undefined);
mock.module("@/store/schedules", () => ({
	addSchedule: mockAddSchedule,
	getSchedules: mockGetSchedules,
	removeSchedule: mockRemoveSchedule,
	findSchedule: mockFindSchedule,
}));

const mockAddTimer = mock(async () => {});
const mockListTimers = mock(() => [] as unknown[]);
const mockRemoveTimer = mock(async () => false);
mock.module("@/store/timers", () => ({
	addTimer: mockAddTimer,
	listTimers: mockListTimers,
	removeTimer: mockRemoveTimer,
}));

mock.module("@/logger", () => ({
	log: {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
	},
}));

const { dispatchToolset, parseRunAt } = await import("@/tools/sets/dispatch");

// ─── helpers ─────────────────────────────────────────────────────────────────

const dummyAgent: AgentDefinition = {
	name: "klaus",
	modelTier: "default",
	tools: [],
	toolsets: [],
	providerTools: [],
	skills: [],
	persistent: false,
	promptPath: "/dev/null",
};

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
	return {
		chatId: "user@s.whatsapp.net",
		agent: dummyAgent,
		flags: {},
		overrides: {},
		assembled: { vars: {}, userVars: {}, messageRefs: {}, totalTokens: 0 },
		...overrides,
	};
}

beforeEach(() => {
	mockDispatch.mockClear();
	mockDispatch.mockImplementation(async () => undefined);
	mockAddSchedule.mockClear();
	mockGetSchedules.mockClear();
	mockGetSchedules.mockImplementation(() => []);
	mockRemoveSchedule.mockClear();
	mockRemoveSchedule.mockImplementation(async () => false);
	mockAddTimer.mockClear();
	mockListTimers.mockClear();
	mockListTimers.mockImplementation(() => []);
	mockRemoveTimer.mockClear();
	mockRemoveTimer.mockImplementation(async () => false);
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("dispatch.agent", () => {
	const tool = dispatchToolset.tools.find(
		(t) => t.name === "dispatch.agent",
	) as (typeof dispatchToolset.tools)[0];

	test("async mode calls dispatch and returns confirmation", async () => {
		const result = await tool.execute(
			{ agent: "helper", objective: "Do stuff", mode: "async" },
			makeContext(),
		);
		expect(result).toContain("Dispatched");
		expect(mockDispatch).toHaveBeenCalledTimes(1);
	});

	test("inline mode returns agent reply or 'done'", async () => {
		mockDispatch.mockImplementation(async () => "Here is the answer.");
		const result = await tool.execute(
			{ agent: "helper", objective: "Do stuff", mode: "inline" },
			makeContext(),
		);
		expect(result).toBe("Here is the answer.");
	});

	test("passes caller from context agent name", async () => {
		await tool.execute(
			{ agent: "helper", objective: "Do stuff", mode: "async" },
			makeContext(),
		);
		const [opts] = mockDispatch.mock.calls[0] as unknown as [
			{ caller: string },
		];
		expect(opts.caller).toBe("klaus");
	});
});

describe("dispatch.schedule", () => {
	const tool = dispatchToolset.tools.find(
		(t) => t.name === "dispatch.schedule",
	) as (typeof dispatchToolset.tools)[0];

	test("creates a schedule", async () => {
		const result = await tool.execute(
			{
				agent: "morning",
				pattern: "0 8 * * *",
				objective: "Morning check",
				label: "morning-check",
			},
			makeContext(),
		);
		expect(result).toContain("morning");
		expect(result).toContain("0 8 * * *");
		expect(mockAddSchedule).toHaveBeenCalledTimes(1);
	});

	test("passes hint when provided", async () => {
		await tool.execute(
			{
				agent: "morning",
				pattern: "0 8 * * *",
				objective: "Check weather",
				hint: "Focus on rain probability",
				label: "weather",
			},
			makeContext(),
		);
		const [entry] = mockAddSchedule.mock.calls[0] as unknown as [
			{ hint?: string },
		];
		expect(entry.hint).toBe("Focus on rain probability");
	});
});

describe("dispatch.timer", () => {
	const tool = dispatchToolset.tools.find(
		(t) => t.name === "dispatch.timer",
	) as (typeof dispatchToolset.tools)[0];

	test("creates a timer with ISO datetime", async () => {
		const result = await tool.execute(
			{
				agent: "klaus",
				runAt: "2026-03-23T17:00:00+01:00",
				objective: "Remind Jan to buy milk",
			},
			makeContext(),
		);
		expect(result).toContain("Timer set");
		expect(mockAddTimer).toHaveBeenCalledTimes(1);
	});

	test("creates a timer with delay string", async () => {
		const before = Date.now();
		await tool.execute(
			{
				agent: "fitness",
				runAt: "2h",
				objective: "Motivational check-in",
			},
			makeContext(),
		);
		const [entry] = mockAddTimer.mock.calls[0] as unknown as [
			{ runAt: string },
		];
		const runAtMs = new Date(entry.runAt).getTime();
		expect(runAtMs).toBeGreaterThanOrEqual(before + 2 * 3_600_000 - 1_000);
		expect(runAtMs).toBeLessThanOrEqual(before + 2 * 3_600_000 + 5_000);
	});
});

describe("parseRunAt", () => {
	test("parses delay strings", () => {
		const before = Date.now();
		const result = new Date(parseRunAt("30m")).getTime();
		expect(result).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1_000);
	});

	test("passes through ISO strings", () => {
		const iso = "2026-12-25T12:00:00Z";
		expect(parseRunAt(iso)).toBe(new Date(iso).toISOString());
	});

	test("throws on invalid input", () => {
		expect(() => parseRunAt("not-a-date")).toThrow();
	});
});

describe("dispatch.list", () => {
	const tool = dispatchToolset.tools.find(
		(t) => t.name === "dispatch.list",
	) as (typeof dispatchToolset.tools)[0];

	test("returns empty message when nothing active", async () => {
		const result = await tool.execute({}, makeContext());
		expect(result).toContain("No active");
	});

	test("lists schedules and timers", async () => {
		mockGetSchedules.mockImplementation(() => [
			{
				id: "s-1",
				agentName: "morning",
				pattern: "0 8 * * *",
				chatId: "c",
				objective: "Check",
				label: "morning-check",
				createdBy: "klaus",
				createdAt: "2026-01-01",
			},
		]);
		mockListTimers.mockImplementation(() => [
			{
				id: "t-1",
				agentName: "klaus",
				chatId: "c",
				objective: "Remind",
				runAt: "2026-03-23T17:00:00Z",
				createdBy: "klaus",
				createdAt: "2026-01-01",
			},
		]);

		const result = await tool.execute({}, makeContext());
		expect(result).toContain("Schedules");
		expect(result).toContain("morning");
		expect(result).toContain("Timers");
		expect(result).toContain("Remind");
	});
});

describe("dispatch.cancel", () => {
	const tool = dispatchToolset.tools.find(
		(t) => t.name === "dispatch.cancel",
	) as (typeof dispatchToolset.tools)[0];

	test("cancels a timer", async () => {
		mockRemoveTimer.mockImplementation(async () => true);
		const result = await tool.execute({ id: "t-1" }, makeContext());
		expect(result).toContain("Cancelled timer");
	});

	test("cancels a schedule when timer not found", async () => {
		mockRemoveTimer.mockImplementation(async () => false);
		mockRemoveSchedule.mockImplementation(async () => true);
		const result = await tool.execute({ id: "s-1" }, makeContext());
		expect(result).toContain("Cancelled schedule");
	});

	test("returns not found when neither exists", async () => {
		const result = await tool.execute({ id: "x-1" }, makeContext());
		expect(result).toContain("No schedule or timer found");
	});
});
