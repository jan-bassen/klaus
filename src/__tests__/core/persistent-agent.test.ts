import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import * as path from "node:path";

// ---- Mocks (must be set up before importing agent.ts) ----
const mockCallModel = mock(async () => ({
	content: "",
	usage: { promptTokens: 10, completionTokens: 5 },
	steps: [],
	output: undefined as unknown,
}));
mock.module("../../core/model-router", () => ({ callModel: mockCallModel }));

mock.module("@/store/conversation", () => ({
	getConversation: mock(async () => []),
	getTraces: mock(async () => new Map()),
	appendTrace: mock(async () => {}),
	appendMessage: mock(async () => "msg-id"),
	appendAck: mock(async () => {}),
	appendReaction: mock(async () => {}),
	findByExternalId: mock(() => null),
	resolveExternalId: mock(() => null),
	resolveMessageId: mock(() => null),
	rebuildIndexes: mock(async () => {}),
	_clearIndexesForTest: mock(() => {}),
}));

const mockAddTimer = mock(async () => {});
const mockRemoveTimer = mock(async () => true);
const mockListTimers = mock(() => [] as Array<Record<string, string>>);

mock.module("@/store/timers", () => ({
	addTimer: mockAddTimer,
	removeTimer: mockRemoveTimer,
	listTimers: mockListTimers,
	loadTimers: mock(async () => {}),
	setOnTimerFire: mock(() => {}),
	stopAllTimers: mock(() => {}),
	_clearTimersForTest: mock(() => {}),
}));

import { clampNextRun, loadAgentDefinition, runAgent } from "@/core/agent";
import type { AssembledContext, TurnContext } from "@/types";

// ---- Helpers ----

const emptyAssembled: AssembledContext = {
	vars: {},
	userVars: {},
	messageRefs: {},
	totalTokens: 0,
};

function makeTurn(
	agentOverrides: Partial<TurnContext["agent"]> = {},
): TurnContext {
	return {
		chatId: "user@s.whatsapp.net",
		message: {
			kind: "whatsapp",
			id: "msg-1",
			chatId: "user@s.whatsapp.net",
			senderId: "user@s.whatsapp.net",
			text: "hello",
			timestamp: new Date(),
			messageKey: {},
		},
		agent: {
			name: "test",
			modelTier: "medium",
			tools: [],
			toolsets: [],
			providerTools: [],
			skills: [],
			persistent: false,
			promptPath: "/dev/null",
			...agentOverrides,
		},
		flags: {},
		overrides: {},
		assembled: { ...emptyAssembled },
	};
}

const tmpPath = path.join(import.meta.dir, "__persistent-test.md");

async function writeAgentFile(
	frontmatter: string,
	body = "You are a test agent.",
): Promise<void> {
	await Bun.write(tmpPath, `---\n${frontmatter}\n---\n${body}`);
}

function cleanup(): void {
	try {
		unlinkSync(tmpPath);
	} catch {
		/* already gone */
	}
}

// ---- Tests ----

describe("persistent agents", () => {
	beforeEach(async () => {
		mockCallModel.mockClear();
		mockAddTimer.mockClear();
		mockRemoveTimer.mockClear();
		mockListTimers.mockClear();
		mockListTimers.mockImplementation(() => []);
		mockCallModel.mockImplementation(async () => ({
			content: "",
			usage: { promptTokens: 10, completionTokens: 5 },
			steps: [],
			output: { nextRun: "2h", objective: "Check vocabulary progress" },
		}));
		await writeAgentFile(
			"name: test\nmodelTier: medium\ntools: []\npersistent: true",
		);
	});

	afterEach(cleanup);

	test("schedules timer from structured output nextRun", async () => {
		const turn = makeTurn({ persistent: true, promptPath: tmpPath });
		await runAgent(turn, turn.agent);

		expect(mockAddTimer).toHaveBeenCalledTimes(1);
		const calls = mockAddTimer.mock.calls as unknown[][];
		const timerArg = calls[0]?.[0] as Record<string, unknown>;
		expect(timerArg.agentName).toBe("test");
		expect(timerArg.chatId).toBe("user@s.whatsapp.net");
		expect(timerArg.objective).toBe("Check vocabulary progress");
		expect(timerArg.createdBy).toBe("persistent:test");
		// runAt should be ~2h in the future
		const runAtMs = new Date(timerArg.runAt as string).getTime();
		const expectedMs = Date.now() + 2 * 3_600_000;
		expect(Math.abs(runAtMs - expectedMs)).toBeLessThan(5_000);
	});

	test("passes Output.object to callModel when persistent", async () => {
		const turn = makeTurn({ persistent: true, promptPath: tmpPath });
		await runAgent(turn, turn.agent);

		const modelCalls = mockCallModel.mock.calls as unknown[][];
		const opts = modelCalls[0]?.[0] as Record<string, unknown>;
		expect(opts.output).toBeDefined();
	});

	test("does not pass output to callModel when not persistent", async () => {
		await writeAgentFile("name: test\nmodelTier: medium\ntools: []");
		const turn = makeTurn({ persistent: false, promptPath: tmpPath });
		await runAgent(turn, turn.agent);

		const modelCalls = mockCallModel.mock.calls as unknown[][];
		const opts = modelCalls[0]?.[0] as Record<string, unknown>;
		expect(opts.output).toBeUndefined();
	});

	test("fallback timer when output is undefined", async () => {
		mockCallModel.mockImplementation(async () => ({
			content: "",
			usage: { promptTokens: 10, completionTokens: 5 },
			steps: [],
			output: undefined,
		}));

		const turn = makeTurn({ persistent: true, promptPath: tmpPath });
		turn.dispatchContext = {
			caller: "system",
			objective: "Original objective",
			mode: { kind: "async" },
		};
		await runAgent(turn, turn.agent);

		expect(mockAddTimer).toHaveBeenCalledTimes(1);
		const calls = mockAddTimer.mock.calls as unknown[][];
		const timerArg = calls[0]?.[0] as Record<string, unknown>;
		expect(timerArg.objective).toBe("Original objective");
		// Fallback is "1h"
		const runAtMs = new Date(timerArg.runAt as string).getTime();
		const expectedMs = Date.now() + 3_600_000;
		expect(Math.abs(runAtMs - expectedMs)).toBeLessThan(5_000);
	});

	test("fallback timer when callModel throws", async () => {
		mockCallModel.mockImplementation(async () => {
			throw new Error("model error");
		});

		const turn = makeTurn({ persistent: true, promptPath: tmpPath });
		turn.dispatchContext = {
			caller: "system",
			objective: "Vocab review",
			mode: { kind: "async" },
		};

		await expect(runAgent(turn, turn.agent)).rejects.toThrow("model error");

		expect(mockAddTimer).toHaveBeenCalledTimes(1);
		const calls = mockAddTimer.mock.calls as unknown[][];
		const timerArg = calls[0]?.[0] as Record<string, unknown>;
		expect(timerArg.objective).toBe("Vocab review");
	});

	test("cancels existing timers for same agent+chatId before scheduling", async () => {
		mockListTimers.mockImplementation(() => [
			{
				id: "old-timer-1",
				agentName: "test",
				chatId: "user@s.whatsapp.net",
				objective: "old objective",
				runAt: new Date(Date.now() + 60_000).toISOString(),
				createdBy: "persistent:test",
				createdAt: new Date().toISOString(),
			},
			{
				id: "other-timer",
				agentName: "other-agent",
				chatId: "user@s.whatsapp.net",
				objective: "unrelated",
				runAt: new Date(Date.now() + 60_000).toISOString(),
				createdBy: "persistent:other-agent",
				createdAt: new Date().toISOString(),
			},
		]);

		const turn = makeTurn({ persistent: true, promptPath: tmpPath });
		await runAgent(turn, turn.agent);

		// Should cancel only the matching timer, not the other one
		expect(mockRemoveTimer).toHaveBeenCalledTimes(1);
		const removeCalls = mockRemoveTimer.mock.calls as unknown[][];
		expect(removeCalls[0]?.[0]).toBe("old-timer-1");
		// And create a new one
		expect(mockAddTimer).toHaveBeenCalledTimes(1);
	});

	test("persistent: true is parsed from frontmatter", async () => {
		await writeAgentFile(
			"name: persist-agent\nmodelTier: medium\ntools: []\npersistent: true",
		);
		const def = await loadAgentDefinition(tmpPath);
		expect(def.persistent).toBe(true);
	});

	test("persistent defaults to false when omitted", async () => {
		await writeAgentFile("name: normal-agent\nmodelTier: medium\ntools: []");
		const def = await loadAgentDefinition(tmpPath);
		expect(def.persistent).toBe(false);
	});
});

describe("clampNextRun", () => {
	test("clamps short delays to minimum", () => {
		const tooSoon = new Date(Date.now() + 10_000).toISOString(); // 10s
		const clamped = clampNextRun(tooSoon);
		const delayMs = new Date(clamped).getTime() - Date.now();
		expect(delayMs).toBeGreaterThanOrEqual(59_000); // ~1 min with tolerance
	});

	test("clamps long delays to maximum", () => {
		const tooLate = new Date(Date.now() + 30 * 86_400_000).toISOString(); // 30 days
		const clamped = clampNextRun(tooLate);
		const delayMs = new Date(clamped).getTime() - Date.now();
		expect(delayMs).toBeLessThanOrEqual(7 * 86_400_000 + 1_000); // 7 days + tolerance
	});

	test("leaves delays within bounds unchanged", () => {
		const justRight = new Date(Date.now() + 3_600_000).toISOString(); // 1h
		const clamped = clampNextRun(justRight);
		expect(clamped).toBe(justRight);
	});
});
