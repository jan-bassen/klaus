import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ConversationMessage } from "@/store/conversation";
import type { AgentDefinition, TurnContext } from "@/types";

// ─── mocks ───────────────────────────────────────────────────────────────────

const mockSearchConversation = mock(
	async (_opts: unknown): Promise<ConversationMessage[]> => [],
);
mock.module("@/store/conversation", () => ({
	searchConversation: mockSearchConversation,
	appendMessage: mock(async () => "id"),
	appendAck: mock(async () => {}),
	appendReaction: mock(async () => {}),
	getConversation: mock(async () => []),
	findByExternalId: mock(() => null),
	resolveExternalId: mock(() => null),
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

const { conversationTool } = await import("@/tools/conversation");

// ─── helpers ─────────────────────────────────────────────────────────────────

const dummyAgent: AgentDefinition = {
	name: "test",
	modelTier: "default",
	tools: [],
	toolsets: [],
	providerTools: [],
	skills: [],
	persistent: false,
	promptPath: "/tmp/test.md",
};

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
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
		agent: dummyAgent,
		flags: {},
		overrides: {},
		messageId: "mid-1",
		assembled: {
			vars: {},
			userVars: {},
			messageRefs: {},
			totalTokens: 0,
		},
		...overrides,
	};
}

function makeMessage(content: string, externalId: string): ConversationMessage {
	return {
		id: crypto.randomUUID(),
		role: "user",
		content,
		createdAt: new Date().toISOString(),
		externalId,
		reactions: [],
	};
}

// ─── tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
	mockSearchConversation.mockClear();
});

describe("conversationTool", () => {
	test("returns formatted messages for text search", async () => {
		mockSearchConversation.mockImplementation(async () => [
			makeMessage("I love pizza", "wa-1"),
			makeMessage("Pizza is great", "wa-2"),
		]);

		const result = await conversationTool.execute(
			{ query: "pizza" },
			makeContext(),
		);
		const typed = result as { count: number; messages: string };
		expect(typed.count).toBe(2);
		expect(typed.messages).toContain("I love pizza");
		expect(typed.messages).toContain("Pizza is great");

		const [opts] = mockSearchConversation.mock.calls[0] as [{ query?: string }];
		expect(opts.query).toBe("pizza");
	});

	test("passes around_message_id as around option", async () => {
		mockSearchConversation.mockImplementation(async () => [
			makeMessage("before", "wa-0"),
			makeMessage("target", "wa-1"),
			makeMessage("after", "wa-2"),
		]);

		const result = await conversationTool.execute(
			{ around_message_id: "wa-1", context_window: 3 },
			makeContext(),
		);
		const typed = result as { count: number; messages: string };
		expect(typed.count).toBe(3);

		const [opts] = mockSearchConversation.mock.calls[0] as [
			{ around?: string; contextWindow?: number },
		];
		expect(opts.around).toBe("wa-1");
		expect(opts.contextWindow).toBe(3);
	});

	test("returns empty result message when no matches", async () => {
		mockSearchConversation.mockImplementation(async () => []);

		const result = await conversationTool.execute(
			{ query: "nonexistent" },
			makeContext(),
		);
		const typed = result as { results: unknown[]; message: string };
		expect(typed.message).toBe("No messages found.");
		expect(typed.results).toHaveLength(0);
	});
});
