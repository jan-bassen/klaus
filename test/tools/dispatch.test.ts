import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentDefinition, TurnContext } from "@/types";

// ─── mocks ───────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	mockDispatch: vi.fn(async (): Promise<string | undefined> => undefined),
	mockAddSchedule: vi.fn(async () => {}),
	mockGetSchedules: vi.fn(() => [] as unknown[]),
	mockRemoveSchedule: vi.fn(async () => false),
	mockFindSchedule: vi.fn(() => undefined),
	mockAddTimer: vi.fn(async () => {}),
	mockListTimers: vi.fn(() => [] as unknown[]),
	mockRemoveTimer: vi.fn(async () => false),
}));

vi.mock("@/agent/dispatch", () => ({ dispatch: mocks.mockDispatch }));

vi.mock("@/store/schedules", () => ({
	addSchedule: mocks.mockAddSchedule,
	getSchedules: mocks.mockGetSchedules,
	removeSchedule: mocks.mockRemoveSchedule,
	findSchedule: mocks.mockFindSchedule,
}));

vi.mock("@/store/timers", () => ({
	addTimer: mocks.mockAddTimer,
	listTimers: mocks.mockListTimers,
	removeTimer: mocks.mockRemoveTimer,
}));

vi.mock("@/logger", () => ({
	log: {
		info: vi.fn(() => {}),
		warn: vi.fn(() => {}),
		error: vi.fn(() => {}),
		debug: vi.fn(() => {}),
	},
}));

const { dispatchToolset, parseRunAt } = await import("@/tools/sets/dispatch");

// ─── helpers ─────────────────────────────────────────────────────────────────

const dummyAgent: AgentDefinition = {
	name: "klaus",
	aliases: [],
	modelTier: "medium",
	tools: [],
	toolsets: [],
	providerTools: [],
	skills: [],
	persistent: false,
	showToolsInContext: true,
	promptPath: "/dev/null",
};

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
	return {
		chatId: "user@s.whatsapp.net",
		agent: dummyAgent,
		overrides: {},
		config: {},
		messageRefs: {},
		vars: {},
		...overrides,
	};
}

beforeEach(() => {
	mocks.mockDispatch.mockClear();
	mocks.mockDispatch.mockImplementation(async () => undefined);
	mocks.mockAddSchedule.mockClear();
	mocks.mockGetSchedules.mockClear();
	mocks.mockGetSchedules.mockImplementation(() => []);
	mocks.mockRemoveSchedule.mockClear();
	mocks.mockRemoveSchedule.mockImplementation(async () => false);
	mocks.mockAddTimer.mockClear();
	mocks.mockListTimers.mockClear();
	mocks.mockListTimers.mockImplementation(() => []);
	mocks.mockRemoveTimer.mockClear();
	mocks.mockRemoveTimer.mockImplementation(async () => false);
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
		expect(mocks.mockDispatch).toHaveBeenCalledTimes(1);
	});

	test("inline mode returns agent reply or 'done'", async () => {
		mocks.mockDispatch.mockImplementation(async () => "Here is the answer.");
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
		const [opts] = mocks.mockDispatch.mock.calls[0] as unknown as [
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
		expect(mocks.mockAddSchedule).toHaveBeenCalledTimes(1);
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
		const [entry] = mocks.mockAddSchedule.mock.calls[0] as unknown as [
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
		expect(mocks.mockAddTimer).toHaveBeenCalledTimes(1);
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
		const [entry] = mocks.mockAddTimer.mock.calls[0] as unknown as [
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
		mocks.mockGetSchedules.mockImplementation(() => [
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
		mocks.mockListTimers.mockImplementation(() => [
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
		mocks.mockRemoveTimer.mockImplementation(async () => true);
		const result = await tool.execute({ id: "t-1" }, makeContext());
		expect(result).toContain("Cancelled timer");
	});

	test("cancels a schedule when timer not found", async () => {
		mocks.mockRemoveTimer.mockImplementation(async () => false);
		mocks.mockRemoveSchedule.mockImplementation(async () => true);
		const result = await tool.execute({ id: "s-1" }, makeContext());
		expect(result).toContain("Cancelled schedule");
	});

	test("returns not found when neither exists", async () => {
		const result = await tool.execute({ id: "x-1" }, makeContext());
		expect(result).toContain("No schedule or timer found");
	});
});
