import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- Mocks (must precede imports) ----

// Mock callModel — not needed for buildConversationMessages but needed for agent import
const mockCallModel = mock(async () => ({
	content: "",
	usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
	steps: [],
}));
mock.module("@/core/model-router", () => ({ callModel: mockCallModel }));

// ---- Imports ----

import { buildConversationMessages } from "@/core/agent";
import {
	_clearIndexesForTest,
	appendMessage,
	appendTrace,
	getTraces,
} from "@/store/conversation";
import type { AgentDefinition, TurnContext } from "@/types";

// ---- Fixtures ----

let tmpDir: string;
let origDataDir: string | undefined;

const dummyAgent: AgentDefinition = {
	name: "test",
	modelTier: "default",
	tools: [],
	promptPath: "/dev/null",
};

function makeTurn(
	overrides: Partial<Omit<TurnContext, "assembled">> = {},
): Omit<TurnContext, "assembled"> {
	return {
		chatId: "user@s.whatsapp.net",
		message: {
			kind: "whatsapp",
			id: "current-msg-ext",
			chatId: "user@s.whatsapp.net",
			senderId: "user@s.whatsapp.net",
			text: "hello",
			timestamp: new Date(),
			messageKey: {},
		},
		agent: dummyAgent,
		flags: {},
		...overrides,
	};
}

beforeEach(async () => {
	tmpDir = join(tmpdir(), `conv-replay-test-${Date.now()}`);
	await mkdir(tmpDir, { recursive: true });
	origDataDir = process.env.DATA_DIR;
	process.env.DATA_DIR = tmpDir;
	_clearIndexesForTest();
});

afterEach(async () => {
	if (origDataDir !== undefined) process.env.DATA_DIR = origDataDir;
	else delete process.env.DATA_DIR;
	await rm(tmpDir, { recursive: true, force: true });
});

// ---- Tests ----

describe("buildConversationMessages", () => {
	test("returns empty for dispatched agent (no message)", async () => {
		const turn = makeTurn();
		delete (turn as { message?: unknown }).message;
		const { messages, messageRefs } = await buildConversationMessages(turn);
		expect(messages).toEqual([]);
		expect(messageRefs).toEqual({});
	});

	test("builds flat user/assistant messages from conversation", async () => {
		const _userMsgId = await appendMessage({
			role: "user",
			content: "hi there",
			externalId: "ext-1",
		});
		await appendMessage({
			role: "assistant",
			content: "hello!",
			externalId: "ext-2",
		});

		const { messages, messageRefs } = await buildConversationMessages(
			makeTurn(),
		);

		expect(messages).toHaveLength(2);
		expect(messages[0]?.role).toBe("user");
		expect(messages[0]?.content as string).toContain("hi there");
		expect(messages[1]?.role).toBe("assistant");
		expect(messages[1]?.content as string).toBe("hello!");
		// messageRefs should have entries
		expect(Object.keys(messageRefs).length).toBe(2);
	});

	test("excludes current inbound message from history", async () => {
		await appendMessage({
			role: "user",
			content: "old message",
			externalId: "ext-old",
		});
		await appendMessage({
			role: "user",
			content: "current message",
			externalId: "current-msg-ext",
		});

		const { messages } = await buildConversationMessages(makeTurn());

		// Should only have the old message, not the current
		expect(messages).toHaveLength(1);
		expect(messages[0]?.content as string).toContain("old message");
	});

	test("reconstructs traces for recent assistant turns", async () => {
		const _userMsgId = await appendMessage({
			role: "user",
			content: "search for X",
			externalId: "ext-u1",
		});
		const assistantMsgId = await appendMessage({
			role: "assistant",
			content: "Here are the results.",
			externalId: "ext-a1",
		});

		await appendTrace(assistantMsgId, [
			{
				reasoning: "I should search the vault",
				toolCalls: [
					{
						toolCallId: "tc-1",
						toolName: "vault_search",
						args: '{"query":"X"}',
					},
				],
				toolResults: [
					{
						toolCallId: "tc-1",
						toolName: "vault_search",
						result: '"Found 3 matches"',
					},
				],
			},
		]);

		const { messages } = await buildConversationMessages(makeTurn());

		// Should have: user msg, assistant (reasoning + tool-call), tool result, assistant (text)
		expect(messages.length).toBeGreaterThanOrEqual(4);
		expect(messages[0]?.role).toBe("user");

		// Assistant message with reasoning + tool call
		const assistantStep = messages[1];
		expect(assistantStep?.role).toBe("assistant");
		const content = assistantStep?.content as Array<{ type: string }>;
		expect(content.some((p) => p.type === "reasoning")).toBe(true);
		expect(content.some((p) => p.type === "tool-call")).toBe(true);

		// Tool result
		expect(messages[2]?.role).toBe("tool");

		// Final text reply
		const finalMsg = messages[messages.length - 1];
		expect(finalMsg?.role).toBe("assistant");
		expect(finalMsg?.content).toBe("Here are the results.");
	});
});

describe("trace persistence", () => {
	test("appendTrace and getTraces round-trip", async () => {
		await appendTrace("msg-123", [
			{
				reasoning: "thinking...",
				toolCalls: [
					{
						toolCallId: "tc-1",
						toolName: "reply",
						args: '{"content":"hi"}',
					},
				],
				toolResults: [
					{
						toolCallId: "tc-1",
						toolName: "reply",
						result: '"sent"',
					},
				],
			},
		]);

		const traces = await getTraces();
		expect(traces.has("msg-123")).toBe(true);
		const steps = traces.get("msg-123");
		expect(steps).toHaveLength(1);
		expect(steps?.[0]?.reasoning).toBe("thinking...");
		expect(steps?.[0]?.toolCalls).toHaveLength(1);
		expect(steps?.[0]?.toolResults).toHaveLength(1);
	});

	test("getTraces returns empty map when no traces exist", async () => {
		await appendMessage({ role: "user", content: "hi" });
		const traces = await getTraces();
		expect(traces.size).toBe(0);
	});
});

describe("token budget trimming", () => {
	test("respects conversation token budget", async () => {
		// Insert many messages to exceed the budget
		for (let i = 0; i < 50; i++) {
			await appendMessage({
				role: "user",
				content: `Message ${i} ${"x".repeat(500)}`,
				externalId: `ext-u${i}`,
			});
			await appendMessage({
				role: "assistant",
				content: `Reply ${i} ${"y".repeat(500)}`,
				externalId: `ext-a${i}`,
			});
		}

		const { messages } = await buildConversationMessages(makeTurn());

		// Should have fewer messages than total due to token budget
		expect(messages.length).toBeLessThan(100);
		expect(messages.length).toBeGreaterThan(0);
	});
});
