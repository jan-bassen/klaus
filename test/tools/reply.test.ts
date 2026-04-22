import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentDefinition, InboundMessage, TurnContext } from "@/types";

// ─── mocks ───────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	mockEnqueueMessage: vi.fn((_msg: unknown, _onSent?: unknown) => {}),
	mockTextToSpeech: vi.fn(
		async (_text: string, _chatId: string): Promise<Buffer | Error> =>
			Buffer.from("fake-audio"),
	),
	mockAppendMessage: vi.fn(async () => "row-uuid-1"),
	mockAppendAck: vi.fn(async () => {}),
}));

vi.mock("@/whatsapp/send", () => ({
	enqueueMessage: mocks.mockEnqueueMessage,
}));

vi.mock("@/whatsapp/voice", () => ({ textToSpeech: mocks.mockTextToSpeech }));

vi.mock("@/store/conversation", () => ({
	appendMessage: mocks.mockAppendMessage,
	appendAck: mocks.mockAppendAck,
	resolveExternalId: vi.fn(() => null),
	findByExternalId: vi.fn(() => null),
	getConversation: vi.fn(async () => []),
	rebuildIndexes: vi.fn(async () => {}),
}));

vi.mock("@/config", () => ({
	settings: {
		tts: { fixedVoiceThreshold: 50 },
	},
}));

vi.mock("@/logger", () => ({
	log: {
		info: vi.fn(() => {}),
		warn: vi.fn(() => {}),
		error: vi.fn(() => {}),
		debug: vi.fn(() => {}),
	},
}));

const { replyTool } = await import("@/variables/tools/reply");

// ─── helpers ─────────────────────────────────────────────────────────────────

const dummyAgent: AgentDefinition = {
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

function makeContext(ctxOverrides: Partial<TurnContext> = {}): TurnContext {
	return {
		chatId: "user@s.whatsapp.net",
		message: dummyMsg,
		agent: dummyAgent,
		overrides: {},
		config: {},
		messageRefs: {},
		vars: {},
		...ctxOverrides,
	};
}

beforeEach(() => {
	mocks.mockEnqueueMessage.mockClear();
	mocks.mockTextToSpeech.mockClear();
	mocks.mockTextToSpeech.mockImplementation(async () =>
		Buffer.from("fake-audio"),
	);
	mocks.mockAppendMessage.mockClear();
	mocks.mockAppendMessage.mockImplementation(async () => "row-uuid-1");
	mocks.mockAppendAck.mockClear();
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("replyTool", () => {
	test('enqueues text message and returns "sent"', async () => {
		const result = await replyTool.execute(
			{ content: "hello world" },
			makeContext(),
		);
		expect(result).toBe("sent");
		expect(mocks.mockEnqueueMessage).toHaveBeenCalledTimes(1);
		const enqueued = mocks.mockEnqueueMessage.mock.calls[0]?.[0] as {
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
		expect(mocks.mockTextToSpeech).toHaveBeenCalledTimes(1);
		const enqueued = mocks.mockEnqueueMessage.mock.calls[0]?.[0] as {
			content: unknown;
			mimeType: string;
		};
		expect(enqueued.content).toBeInstanceOf(Buffer);
		expect(enqueued.mimeType).toBe("audio/mpeg");
	});

	test("voice TTS failure falls back to text", async () => {
		mocks.mockTextToSpeech.mockImplementation(
			async () => new Error("API down"),
		);
		await replyTool.execute(
			{ content: "fallback text", voice: true },
			makeContext(),
		);
		const enqueued = mocks.mockEnqueueMessage.mock.calls[0]?.[0] as {
			content: string;
		};
		expect(enqueued.content).toBe("fallback text");
	});

	test('messageRef "current" quotes the current message', async () => {
		await replyTool.execute(
			{ content: "reply", messageRef: "current" },
			makeContext(),
		);
		const enqueued = mocks.mockEnqueueMessage.mock.calls[0]?.[0] as {
			quoted: { externalId: string; fromMe: boolean };
		};
		expect(enqueued.quoted).toBeDefined();
		expect(enqueued.quoted.externalId).toBe(dummyMsg.id);
		expect(enqueued.quoted.fromMe).toBe(false); // user message
	});

	test("messageRef resolves from messageRefs", async () => {
		const ctx = makeContext({
			messageRefs: {
				"3": { externalId: "ext-3", role: "assistant" },
			},
		});
		await replyTool.execute({ content: "reply", messageRef: "3" }, ctx);
		const enqueued = mocks.mockEnqueueMessage.mock.calls[0]?.[0] as {
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
		expect(mocks.mockEnqueueMessage).not.toHaveBeenCalled();
	});

	test("sends without inbound message context (proactive/scheduled)", async () => {
		const result = await replyTool.execute({ content: "proactive hello" }, {
			...makeContext(),
			message: undefined,
		} as unknown as Parameters<typeof replyTool.execute>[1]);
		expect(result).toBe("sent");
		expect(mocks.mockEnqueueMessage).toHaveBeenCalledTimes(1);
		const enqueued = mocks.mockEnqueueMessage.mock.calls[0]?.[0] as {
			content: string;
			chatId: string;
			dedupKey: string;
		};
		expect(enqueued.content).toBe("proactive hello");
		expect(enqueued.chatId).toBe("user@s.whatsapp.net");
		expect(enqueued.dedupKey).toContain("user@s.whatsapp.net:reply:");
	});

	test("_replyCollector captures content instead of sending to WhatsApp", async () => {
		const collector: string[] = [];
		const result = await replyTool.execute(
			{ content: "captured reply" },
			makeContext({ _replyCollector: collector }),
		);
		expect(result).toBe("sent");
		expect(collector).toEqual(["captured reply"]);
		expect(mocks.mockEnqueueMessage).not.toHaveBeenCalled();
		expect(mocks.mockAppendMessage).not.toHaveBeenCalled();
	});

	test("_replyCollector collects multiple replies", async () => {
		const collector: string[] = [];
		const ctx = makeContext({ _replyCollector: collector });
		await replyTool.execute({ content: "first" }, ctx);
		await replyTool.execute({ content: "second" }, ctx);
		expect(collector).toEqual(["first", "second"]);
		expect(mocks.mockEnqueueMessage).not.toHaveBeenCalled();
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
		expect(mocks.mockEnqueueMessage).not.toHaveBeenCalled();
	});
});
