import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConversationMessage } from "@/store/conversation";
import type { AgentDefinition, TurnContext } from "@/types";

// ─── mocks ───────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	mockSearchConversation: vi.fn(
		async (_opts: unknown): Promise<ConversationMessage[]> => [],
	),
}));

vi.mock("@/store/conversation", () => ({
	searchConversation: mocks.mockSearchConversation,
	appendMessage: vi.fn(async () => "id"),
	appendAck: vi.fn(async () => {}),
	appendReaction: vi.fn(async () => {}),
	getConversation: vi.fn(async () => []),
	findByExternalId: vi.fn(() => null),
	resolveExternalId: vi.fn(() => null),
	rebuildIndexes: vi.fn(async () => {}),
}));

vi.mock("@/logger", () => ({
	log: {
		info: vi.fn(() => {}),
		warn: vi.fn(() => {}),
		error: vi.fn(() => {}),
		debug: vi.fn(() => {}),
	},
}));

const { conversationTool } = await import("@/variables/tools/conversation");

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
		overrides: {},
		config: {},
		messageRefs: {},
		messageId: "mid-1",
		vars: {},
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
	mocks.mockSearchConversation.mockClear();
});

describe("conversationTool", () => {
	test("returns formatted messages for text search", async () => {
		mocks.mockSearchConversation.mockImplementation(async () => [
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

		const [opts] = mocks.mockSearchConversation.mock.calls[0] as [
			{ query?: string },
		];
		expect(opts.query).toBe("pizza");
	});

	test("passes around_message_id as around option", async () => {
		mocks.mockSearchConversation.mockImplementation(async () => [
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

		const [opts] = mocks.mockSearchConversation.mock.calls[0] as [
			{ around?: string; contextWindow?: number },
		];
		expect(opts.around).toBe("wa-1");
		expect(opts.contextWindow).toBe(3);
	});

	test("returns empty result message when no matches", async () => {
		mocks.mockSearchConversation.mockImplementation(async () => []);

		const result = await conversationTool.execute(
			{ query: "nonexistent" },
			makeContext(),
		);
		const typed = result as { results: unknown[]; message: string };
		expect(typed.message).toBe("No messages found.");
		expect(typed.results).toHaveLength(0);
	});
});
