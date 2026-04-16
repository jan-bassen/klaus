import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConversationMessage } from "@/store/conversation";
import type { InboundMessage } from "@/types";

const mocks = vi.hoisted(() => ({
	mockEnqueueMessage: vi.fn((_opts: unknown) => undefined),
	mockSendReaction: vi.fn(
		async (_chatId: string, _key: unknown, _e: string) => undefined,
	),
	mockAppendSupersede: vi.fn(
		async (_id: string, _reason?: string) => undefined,
	),
	mockAppendReaction: vi.fn(async (_r: unknown) => undefined),
	mockFindByExternalId: vi.fn(
		(_id: string) => null as { messageId: string } | null,
	),
	mockExecuteRetry: vi.fn(
		async (_chatId: string, _target: ConversationMessage) => undefined,
	),
	mockLoadHistory: vi.fn(async () => [] as ConversationMessage[]),
}));

vi.mock("@/whatsapp/send", () => ({
	enqueueMessage: mocks.mockEnqueueMessage,
	sendReaction: mocks.mockSendReaction,
}));

vi.mock("@/whatsapp/connection", () => ({
	getSocket: () => ({ user: { id: "bot@s.whatsapp.net" } }),
}));

vi.mock("@/store/conversation", () => ({
	appendSupersede: mocks.mockAppendSupersede,
	appendReaction: mocks.mockAppendReaction,
	findByExternalId: mocks.mockFindByExternalId,
}));

vi.mock("@/pipeline/retry", () => ({
	executeRetry: mocks.mockExecuteRetry,
	loadHistory: mocks.mockLoadHistory,
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
	mocks.mockEnqueueMessage.mockClear();
	mocks.mockSendReaction.mockClear();
	mocks.mockAppendSupersede.mockClear();
	mocks.mockAppendReaction.mockClear();
	mocks.mockFindByExternalId.mockClear();
	mocks.mockExecuteRetry.mockClear();
	mocks.mockLoadHistory.mockClear();
	mocks.mockExecuteRetry.mockImplementation(async () => undefined);
	mocks.mockFindByExternalId.mockImplementation(() => null);
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
		mocks.mockLoadHistory.mockResolvedValue([userMsg, retrySelf]);
		mocks.mockFindByExternalId.mockImplementation((id) =>
			id === "wa-retry-cmd" ? { messageId: "m-retry" } : null,
		);

		await retryCommand.execute(makeMsg(), []);

		expect(mocks.mockExecuteRetry).toHaveBeenCalledTimes(1);
		const [, target] = mocks.mockExecuteRetry.mock.calls[0] as [
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
		mocks.mockLoadHistory.mockResolvedValue([userMsg, asstMsg, retrySelf]);
		mocks.mockFindByExternalId.mockImplementation((id) => {
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

		const [, target] = mocks.mockExecuteRetry.mock.calls[0] as [
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
		mocks.mockLoadHistory.mockResolvedValue([old, newer]);
		mocks.mockFindByExternalId.mockImplementation((id) =>
			id === "wa-old" ? { messageId: "m-old" } : null,
		);

		await retryCommand.execute(
			makeMsg({ quotedMessage: { externalId: "wa-old" } }),
			[],
		);

		const [, target] = mocks.mockExecuteRetry.mock.calls[0] as [
			string,
			ConversationMessage,
		];
		expect(target.id).toBe("m-old");
	});

	test("empty history → replies with 'nothing to retry'", async () => {
		mocks.mockLoadHistory.mockResolvedValue([]);
		await retryCommand.execute(makeMsg(), []);

		expect(mocks.mockExecuteRetry).not.toHaveBeenCalled();
		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
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
		mocks.mockLoadHistory.mockResolvedValue([userMsg, asstMsg, retrySelf]);
		mocks.mockFindByExternalId.mockImplementation((id) => {
			if (id === "wa-a") return { messageId: "m-asst" };
			if (id === "wa-retry-cmd") return { messageId: "m-retry" };
			return null;
		});

		await retryCommand.execute(
			makeMsg({ quotedMessage: { externalId: "wa-a" } }),
			[],
		);

		const ids = mocks.mockAppendSupersede.mock.calls.map(
			(c) => (c as [string])[0],
		);
		expect(ids).toContain("m-retry");
		expect(ids).toContain("m-asst");
	});
});

describe("/retry error handling", () => {
	test("applies reaction on retry failure", async () => {
		const userMsg = row({
			id: "m-user",
			role: "user",
			content: "q",
			externalId: "wa-u",
		});
		mocks.mockLoadHistory.mockResolvedValue([userMsg]);
		mocks.mockExecuteRetry.mockImplementation(async () => {
			throw new Error("boom");
		});

		await retryCommand.execute(makeMsg(), []);

		expect(mocks.mockSendReaction).toHaveBeenCalled();
		expect(mocks.mockEnqueueMessage).toHaveBeenCalled();
	});

	test("clears reaction on retry success", async () => {
		const userMsg = row({
			id: "m-user",
			role: "user",
			content: "q",
			externalId: "wa-u",
		});
		mocks.mockLoadHistory.mockResolvedValue([userMsg]);

		await retryCommand.execute(makeMsg(), []);

		const emojiArgs = mocks.mockSendReaction.mock.calls.map(
			(c) => (c as [string, unknown, string])[2],
		);
		expect(emojiArgs).toContain("");
	});
});
