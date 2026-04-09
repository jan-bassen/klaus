import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { InboundMessage } from "@/types";

const mockEnqueueMessage = mock((_opts: unknown) => undefined);
mock.module("@/whatsapp/send", () => ({ enqueueMessage: mockEnqueueMessage }));

const mockAppendBreak = mock(async () => {});
mock.module("@/store/conversation", () => ({
	appendBreak: mockAppendBreak,
	appendMessage: mock(async () => "id"),
	appendAck: mock(async () => {}),
	appendReaction: mock(async () => {}),
	appendTrace: mock(async () => {}),
	getConversation: mock(async () => []),
	findByExternalId: mock(() => null),
	resolveExternalId: mock(() => null),
	resolveMessageId: mock(() => null),
	rebuildIndexes: mock(async () => {}),
	readAllMessages: mock(async () => []),
	searchConversation: mock(async () => []),
	getTraces: mock(async () => new Map()),
	_clearIndexesForTest: mock(() => {}),
}));

const { breakCommand } = await import("@/commands/break");

function makeMsg(): InboundMessage {
	return {
		kind: "whatsapp",
		id: crypto.randomUUID(),
		chatId: "user@s.whatsapp.net",
		senderId: "user@s.whatsapp.net",
		timestamp: new Date(),
		messageKey: {},
	};
}

beforeEach(() => {
	mockEnqueueMessage.mockClear();
	mockAppendBreak.mockClear();
});

describe("/break", () => {
	test("calls appendBreak and sends confirmation", async () => {
		await breakCommand.execute(makeMsg(), []);
		expect(mockAppendBreak).toHaveBeenCalledTimes(1);
		expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toMatch(/break/i);
	});
});
