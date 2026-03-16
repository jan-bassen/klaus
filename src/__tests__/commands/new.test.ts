import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { InboundMessage } from "@/types";

const mockEnqueueMessage = mock((_opts: unknown) => undefined);
mock.module("@/whatsapp/send", () => ({ enqueueMessage: mockEnqueueMessage }));

const mockRotate = mock(async () => {});
mock.module("@/store/conversation", () => ({
	rotate: mockRotate,
	appendMessage: mock(async () => "id"),
	appendAck: mock(async () => {}),
	appendReaction: mock(async () => {}),
	getConversation: mock(async () => []),
	findByExternalId: mock(() => null),
	resolveExternalId: mock(() => null),
	resolveMessageId: mock(() => null),
	rebuildIndexes: mock(async () => {}),
	_clearIndexesForTest: mock(() => {}),
}));

const { newCommand } = await import("@/commands/new");

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
	mockRotate.mockClear();
});

describe("/new", () => {
	test("calls rotate and sends confirmation", async () => {
		await newCommand.execute(makeMsg(), []);
		expect(mockRotate).toHaveBeenCalledTimes(1);
		expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toMatch(/archived/i);
	});
});
