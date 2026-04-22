import { unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ---- Mocks (must be set up before importing agent.ts) ----
const mocks = vi.hoisted(() => ({
	mockCallModel: vi.fn(async () => ({
		content: "",
		usage: { promptTokens: 10, completionTokens: 5 },
		steps: [],
		durationMs: 100,
		output: undefined as unknown,
	})),
	mockGetConversation: vi.fn(async () => []),
	mockGetTraces: vi.fn(async () => new Map()),
	mockAppendTrace: vi.fn(async () => {}),
	mockAppendMessage: vi.fn(async () => "msg-id"),
	mockAppendAck: vi.fn(async () => {}),
	mockAppendReaction: vi.fn(async () => {}),
	mockFindByExternalId: vi.fn(() => null),
	mockResolveExternalId: vi.fn(() => null),
	mockResolveMessageId: vi.fn(() => null),
	mockRebuildIndexes: vi.fn(async () => {}),
	mockAddTimer: vi.fn(async () => {}),
	mockRemoveTimer: vi.fn(async () => true),
	mockListTimers: vi.fn(() => [] as Array<Record<string, string>>),
	mockLoadTimers: vi.fn(async () => {}),
	mockSetOnTimerFire: vi.fn(() => {}),
	mockStopAllTimers: vi.fn(() => {}),
}));

vi.mock("@/agent/model", () => ({ callModel: mocks.mockCallModel }));

vi.mock("@/store/conversation", () => ({
	getConversation: mocks.mockGetConversation,
	getTraces: mocks.mockGetTraces,
	appendTrace: mocks.mockAppendTrace,
	appendMessage: mocks.mockAppendMessage,
	appendAck: mocks.mockAppendAck,
	appendReaction: mocks.mockAppendReaction,
	findByExternalId: mocks.mockFindByExternalId,
	resolveExternalId: mocks.mockResolveExternalId,
	resolveMessageId: mocks.mockResolveMessageId,
	rebuildIndexes: mocks.mockRebuildIndexes,
}));

vi.mock("@/store/timers", () => ({
	addTimer: mocks.mockAddTimer,
	removeTimer: mocks.mockRemoveTimer,
	listTimers: mocks.mockListTimers,
	loadTimers: mocks.mockLoadTimers,
	setOnTimerFire: mocks.mockSetOnTimerFire,
	stopAllTimers: mocks.mockStopAllTimers,
}));

import { loadAgentDefinition } from "@/agent/definitions";
import { clampNextRun } from "@/agent/persistent";
import { runAgent } from "@/agent/runner";
import type { TurnContext } from "@/types";

// ---- Helpers ----

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
			aliases: [],
			modelTier: "medium",
			tools: [],
			toolsets: [],
			providerTools: [],
			skills: [],
			persistent: false,
			showToolsInContext: true,
			promptPath: "/dev/null",
			...agentOverrides,
		},
		overrides: {},
		config: {},
		messageRefs: {},
		vars: {},
	};
}

const tmpPath = path.join(import.meta.dirname, "__persistent-test.md");

async function writeAgentFile(
	frontmatter: string,
	body = "You are a test agent.",
): Promise<void> {
	writeFileSync(tmpPath, `---\n${frontmatter}\n---\n${body}`, "utf-8");
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
		mocks.mockCallModel.mockClear();
		mocks.mockAddTimer.mockClear();
		mocks.mockRemoveTimer.mockClear();
		mocks.mockListTimers.mockClear();
		mocks.mockListTimers.mockImplementation(() => []);
		mocks.mockCallModel.mockImplementation(async () => ({
			content: "",
			usage: { promptTokens: 10, completionTokens: 5 },
			steps: [],
			durationMs: 100,
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

		expect(mocks.mockAddTimer).toHaveBeenCalledTimes(1);
		const calls = mocks.mockAddTimer.mock.calls as unknown[][];
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

		const modelCalls = mocks.mockCallModel.mock.calls as unknown[][];
		const opts = modelCalls[0]?.[0] as Record<string, unknown>;
		expect(opts.output).toBeDefined();
	});

	test("does not pass output to callModel when not persistent", async () => {
		await writeAgentFile("name: test\nmodelTier: medium\ntools: []");
		const turn = makeTurn({
			persistent: false,
			showToolsInContext: true,
			promptPath: tmpPath,
		});
		await runAgent(turn, turn.agent);

		const modelCalls = mocks.mockCallModel.mock.calls as unknown[][];
		const opts = modelCalls[0]?.[0] as Record<string, unknown>;
		expect(opts.output).toBeUndefined();
	});

	test("fallback timer when output is undefined", async () => {
		mocks.mockCallModel.mockImplementation(async () => ({
			content: "",
			usage: { promptTokens: 10, completionTokens: 5 },
			steps: [],
			durationMs: 100,
			output: undefined,
		}));

		const turn = makeTurn({ persistent: true, promptPath: tmpPath });
		turn.dispatchContext = {
			caller: "system",
			objective: "Original objective",
			mode: { kind: "async" },
		};
		await runAgent(turn, turn.agent);

		expect(mocks.mockAddTimer).toHaveBeenCalledTimes(1);
		const calls = mocks.mockAddTimer.mock.calls as unknown[][];
		const timerArg = calls[0]?.[0] as Record<string, unknown>;
		expect(timerArg.objective).toBe("Original objective");
		// Fallback is "1h"
		const runAtMs = new Date(timerArg.runAt as string).getTime();
		const expectedMs = Date.now() + 3_600_000;
		expect(Math.abs(runAtMs - expectedMs)).toBeLessThan(5_000);
	});

	test("fallback timer when callModel throws", async () => {
		mocks.mockCallModel.mockImplementation(async () => {
			throw new Error("model error");
		});

		const turn = makeTurn({ persistent: true, promptPath: tmpPath });
		turn.dispatchContext = {
			caller: "system",
			objective: "Vocab review",
			mode: { kind: "async" },
		};

		await expect(runAgent(turn, turn.agent)).rejects.toThrow("model error");

		expect(mocks.mockAddTimer).toHaveBeenCalledTimes(1);
		const calls = mocks.mockAddTimer.mock.calls as unknown[][];
		const timerArg = calls[0]?.[0] as Record<string, unknown>;
		expect(timerArg.objective).toBe("Vocab review");
	});

	test("cancels existing timers for same agent+chatId before scheduling", async () => {
		mocks.mockListTimers.mockImplementation(() => [
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
		expect(mocks.mockRemoveTimer).toHaveBeenCalledTimes(1);
		const removeCalls = mocks.mockRemoveTimer.mock.calls as unknown[][];
		expect(removeCalls[0]?.[0]).toBe("old-timer-1");
		// And create a new one
		expect(mocks.mockAddTimer).toHaveBeenCalledTimes(1);
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
