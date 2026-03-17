import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentDefinition, InboundMessage, TurnContext } from "@/types";

// ─── mocks ───────────────────────────────────────────────────────────────────

const mockEnqueueMessage = mock((_msg: unknown, _onSent?: unknown) => {});
mock.module("@/whatsapp/send", () => ({ enqueueMessage: mockEnqueueMessage }));

const mockTextToSpeech = mock(
	async (_text: string, _chatId: string): Promise<Buffer | Error> =>
		Buffer.from("fake-audio"),
);
mock.module("@/whatsapp/tts", () => ({ textToSpeech: mockTextToSpeech }));

const mockAppendMessage = mock(async () => "row-uuid-1");
const mockAppendAck = mock(async () => {});
mock.module("@/store/conversation", () => ({
	appendMessage: mockAppendMessage,
	appendAck: mockAppendAck,
	resolveExternalId: mock(() => null),
	findByExternalId: mock(() => null),
	getConversation: mock(async () => []),
	rebuildIndexes: mock(async () => {}),
	_clearIndexesForTest: mock(() => {}),
}));

mock.module("@/logger", () => ({
	log: {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
	},
}));

const { replyTool } = await import("@/tools/reply");

// ─── helpers ─────────────────────────────────────────────────────────────────

const dummyAgent: AgentDefinition = {
	name: "test",
	modelTier: "default",
	tools: [],
	promptPath: "/dev/null",
};

const dummyMsg: InboundMessage = {
	kind: "whatsapp",
	id: "msg-ext-1",
	chatId: "user@s.whatsapp.net",
	senderId: "user@s.whatsapp.net",
	text: "hi",
	timestamp: new Date(),
	messageKey: {},
};

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
	return {
		chatId: "user@s.whatsapp.net",
		message: dummyMsg,
		agent: dummyAgent,
		flags: {},
		assembled: { vars: {}, totalTokens: 0 },
		...overrides,
	};
}

beforeEach(() => {
	mockEnqueueMessage.mockClear();
	mockTextToSpeech.mockClear();
	mockTextToSpeech.mockImplementation(async () => Buffer.from("fake-audio"));
	mockAppendMessage.mockClear();
	mockAppendMessage.mockImplementation(async () => "row-uuid-1");
	mockAppendAck.mockClear();
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("replyTool", () => {
	test('enqueues text message and returns "sent"', async () => {
		const result = await replyTool.execute(
			{ content: "hello world" },
			makeContext(),
		);
		expect(result).toBe("sent");
		expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
		const enqueued = mockEnqueueMessage.mock.calls[0]?.[0] as {
			content: string;
			chatId: string;
		};
		expect(enqueued.content).toBe("hello world");
		expect(enqueued.chatId).toBe("user@s.whatsapp.net");
	});

	test("voice: true calls textToSpeech and enqueues audio", async () => {
		await replyTool.execute(
			{ content: "say this", voice: true },
			makeContext(),
		);
		expect(mockTextToSpeech).toHaveBeenCalledTimes(1);
		const enqueued = mockEnqueueMessage.mock.calls[0]?.[0] as {
			content: unknown;
			mimeType: string;
		};
		expect(enqueued.content).toBeInstanceOf(Buffer);
		expect(enqueued.mimeType).toBe("audio/mpeg");
	});

	test("voice TTS failure falls back to text", async () => {
		mockTextToSpeech.mockImplementation(async () => new Error("API down"));
		await replyTool.execute(
			{ content: "fallback text", voice: true },
			makeContext(),
		);
		const enqueued = mockEnqueueMessage.mock.calls[0]?.[0] as {
			content: string;
		};
		expect(enqueued.content).toBe("fallback text");
	});

	test('messageRef "current" quotes the current message', async () => {
		await replyTool.execute(
			{ content: "reply", messageRef: "current" },
			makeContext(),
		);
		const enqueued = mockEnqueueMessage.mock.calls[0]?.[0] as {
			quoted: { externalId: string; fromMe: boolean };
		};
		expect(enqueued.quoted).toBeDefined();
		expect(enqueued.quoted.externalId).toBe(dummyMsg.id);
		expect(enqueued.quoted.fromMe).toBe(false); // user message
	});

	test("messageRef resolves from assembled _messageRefs", async () => {
		const ctx = makeContext({
			assembled: {
				vars: {
					_messageRefs: {
						"3": { externalId: "ext-3", role: "assistant" },
					},
				},
				totalTokens: 0,
			},
		});
		await replyTool.execute({ content: "reply", messageRef: "3" }, ctx);
		const enqueued = mockEnqueueMessage.mock.calls[0]?.[0] as {
			quoted: { externalId: string; fromMe: boolean };
		};
		expect(enqueued.quoted.externalId).toBe("ext-3");
		expect(enqueued.quoted.fromMe).toBe(true); // assistant message
	});

	test("unknown messageRef returns error", async () => {
		const result = await replyTool.execute(
			{ content: "reply", messageRef: "99" },
			makeContext(),
		);
		expect(result).toEqual({ error: "Unknown message reference: #99" });
		expect(mockEnqueueMessage).not.toHaveBeenCalled();
	});

	test("sends without inbound message context (proactive/scheduled)", async () => {
		const result = await replyTool.execute({ content: "proactive hello" }, {
			...makeContext(),
			message: undefined,
		} as unknown as Parameters<typeof replyTool.execute>[1]);
		expect(result).toBe("sent");
		expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
		const enqueued = mockEnqueueMessage.mock.calls[0]?.[0] as {
			content: string;
			chatId: string;
			dedupKey: string;
		};
		expect(enqueued.content).toBe("proactive hello");
		expect(enqueued.chatId).toBe("user@s.whatsapp.net");
		expect(enqueued.dedupKey).toContain("user@s.whatsapp.net:reply:");
	});

	test('messageRef "current" without inbound message returns error', async () => {
		const result = await replyTool.execute(
			{ content: "reply", messageRef: "current" },
			{
				...makeContext(),
				message: undefined,
			} as unknown as Parameters<typeof replyTool.execute>[1],
		);
		expect(result).toEqual({
			error: 'messageRef "current" requires an inbound message context',
		});
		expect(mockEnqueueMessage).not.toHaveBeenCalled();
	});
});
