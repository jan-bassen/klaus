import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ConversationMessage } from "@/store/conversation";
import type { InboundMessage } from "@/types";

const mockEnqueueMessage = mock((_opts: unknown) => undefined);
const mockSendReaction = mock(
	async (_chatId: string, _key: unknown, _e: string) => undefined,
);
mock.module("@/whatsapp/send", () => ({
	enqueueMessage: mockEnqueueMessage,
	sendReaction: mockSendReaction,
}));

mock.module("@/whatsapp/connection", () => ({
	getSocket: () => ({ user: { id: "bot@s.whatsapp.net" } }),
}));

const mockAppendSupersede = mock(
	async (_id: string, _reason?: string) => undefined,
);
const mockAppendReaction = mock(async (_r: unknown) => undefined);
const mockFindByExternalId = mock(
	(_id: string) => null as { messageId: string } | null,
);
mock.module("@/store/conversation", () => ({
	appendSupersede: mockAppendSupersede,
	appendReaction: mockAppendReaction,
	findByExternalId: mockFindByExternalId,
}));

const mockExecuteRetry = mock(
	async (_chatId: string, _target: ConversationMessage) => undefined,
);
const mockLoadHistory = mock(async () => [] as ConversationMessage[]);
mock.module("@/pipeline/retry", () => ({
	executeRetry: mockExecuteRetry,
	loadHistory: mockLoadHistory,
}));

import { retryCommand } from "@/commands/retry";

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		kind: "whatsapp",
		id: "wa-retry-cmd",
		chatId: "user@s.whatsapp.net",
		senderId: "user@s.whatsapp.net",
		text: "/retry",
		timestamp: new Date(),
		messageKey: {},
		...overrides,
	};
}

function row(
	opts: Partial<ConversationMessage> & Pick<ConversationMessage, "id" | "role">,
): ConversationMessage {
	return {
		content: "",
		createdAt: new Date().toISOString(),
		reactions: [],
		...opts,
	};
}

beforeEach(() => {
	mockEnqueueMessage.mockClear();
	mockSendReaction.mockClear();
	mockAppendSupersede.mockClear();
	mockAppendReaction.mockClear();
	mockFindByExternalId.mockClear();
	mockExecuteRetry.mockClear();
	mockLoadHistory.mockClear();
	mockExecuteRetry.mockImplementation(async () => undefined);
	mockFindByExternalId.mockImplementation(() => null);
});

describe("/retry target resolution", () => {
	test("no quote → retries the most recent non-command user message", async () => {
		const userMsg = row({
			id: "m-user",
			role: "user",
			content: "hello",
			externalId: "wa-hello",
		});
		const retrySelf = row({
			id: "m-retry",
			role: "user",
			content: "/retry",
			externalId: "wa-retry-cmd",
			command: "retry",
		});
		mockLoadHistory.mockResolvedValue([userMsg, retrySelf]);
		mockFindByExternalId.mockImplementation((id) =>
			id === "wa-retry-cmd" ? { messageId: "m-retry" } : null,
		);

		await retryCommand.execute(makeMsg(), []);

		expect(mockExecuteRetry).toHaveBeenCalledTimes(1);
		const [, target] = mockExecuteRetry.mock.calls[0] as [
			string,
			ConversationMessage,
		];
		expect(target.id).toBe("m-user");
	});

	test("quoted assistant message → walks back to preceding user message", async () => {
		const userMsg = row({
			id: "m-user",
			role: "user",
			content: "question",
			externalId: "wa-q",
		});
		const asstMsg = row({
			id: "m-asst",
			role: "assistant",
			content: "answer",
			externalId: "wa-a",
		});
		const retrySelf = row({
			id: "m-retry",
			role: "user",
			content: "/retry",
			externalId: "wa-retry-cmd",
			command: "retry",
		});
		mockLoadHistory.mockResolvedValue([userMsg, asstMsg, retrySelf]);
		mockFindByExternalId.mockImplementation((id) => {
			if (id === "wa-a") return { messageId: "m-asst" };
			if (id === "wa-retry-cmd") return { messageId: "m-retry" };
			return null;
		});

		await retryCommand.execute(
			makeMsg({
				quotedMessage: { externalId: "wa-a" },
			}),
			[],
		);

		const [, target] = mockExecuteRetry.mock.calls[0] as [
			string,
			ConversationMessage,
		];
		expect(target.id).toBe("m-user");
	});

	test("quoted user message → retries that message directly", async () => {
		const old = row({
			id: "m-old",
			role: "user",
			content: "old q",
			externalId: "wa-old",
		});
		const newer = row({
			id: "m-new",
			role: "user",
			content: "newer q",
			externalId: "wa-new",
		});
		mockLoadHistory.mockResolvedValue([old, newer]);
		mockFindByExternalId.mockImplementation((id) =>
			id === "wa-old" ? { messageId: "m-old" } : null,
		);

		await retryCommand.execute(
			makeMsg({ quotedMessage: { externalId: "wa-old" } }),
			[],
		);

		const [, target] = mockExecuteRetry.mock.calls[0] as [
			string,
			ConversationMessage,
		];
		expect(target.id).toBe("m-old");
	});

	test("empty history → replies with 'nothing to retry'", async () => {
		mockLoadHistory.mockResolvedValue([]);
		await retryCommand.execute(makeMsg(), []);

		expect(mockExecuteRetry).not.toHaveBeenCalled();
		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toMatch(/nothing to retry/i);
	});
});

describe("/retry supersede behavior", () => {
	test("supersedes the /retry command itself and the following assistant reply", async () => {
		const userMsg = row({
			id: "m-user",
			role: "user",
			content: "q",
			externalId: "wa-u",
		});
		const asstMsg = row({
			id: "m-asst",
			role: "assistant",
			content: "a",
			externalId: "wa-a",
		});
		const retrySelf = row({
			id: "m-retry",
			role: "user",
			content: "/retry",
			externalId: "wa-retry-cmd",
			command: "retry",
		});
		mockLoadHistory.mockResolvedValue([userMsg, asstMsg, retrySelf]);
		mockFindByExternalId.mockImplementation((id) => {
			if (id === "wa-a") return { messageId: "m-asst" };
			if (id === "wa-retry-cmd") return { messageId: "m-retry" };
			return null;
		});

		await retryCommand.execute(
			makeMsg({ quotedMessage: { externalId: "wa-a" } }),
			[],
		);

		const ids = mockAppendSupersede.mock.calls.map((c) => (c as [string])[0]);
		expect(ids).toContain("m-retry");
		expect(ids).toContain("m-asst");
	});
});

describe("/retry error handling", () => {
	test("applies ❌ reaction on retry failure", async () => {
		const userMsg = row({
			id: "m-user",
			role: "user",
			content: "q",
			externalId: "wa-u",
		});
		mockLoadHistory.mockResolvedValue([userMsg]);
		mockExecuteRetry.mockImplementation(async () => {
			throw new Error("boom");
		});

		await retryCommand.execute(makeMsg(), []);

		const emojiArgs = mockSendReaction.mock.calls.map(
			(c) => (c as [string, unknown, string])[2],
		);
		expect(emojiArgs).toContain("❌");
		expect(mockEnqueueMessage).toHaveBeenCalled();
	});

	test("clears ❌ reaction on retry success", async () => {
		const userMsg = row({
			id: "m-user",
			role: "user",
			content: "q",
			externalId: "wa-u",
		});
		mockLoadHistory.mockResolvedValue([userMsg]);

		await retryCommand.execute(makeMsg(), []);

		const emojiArgs = mockSendReaction.mock.calls.map(
			(c) => (c as [string, unknown, string])[2],
		);
		expect(emojiArgs).toContain("");
	});
});
