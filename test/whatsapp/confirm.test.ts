import { beforeEach, describe, expect, test, vi } from "vitest";
import type { InboundMessage } from "@/types";

// Must be declared before importing the module under test so Vitest hoists the mock.
const { mockSendMessage } = vi.hoisted(() => ({
	mockSendMessage: vi.fn(async () => ({
		key: { id: "sent-msg-id", remoteJid: "chat@s.whatsapp.net", fromMe: true },
	})),
}));

vi.mock("@/whatsapp/connection", () => ({
	getSocket: () => ({ sendMessage: mockSendMessage }),
}));

// Logger is a no-op in tests.
vi.mock("@/logger", () => ({
	log: {
		info: vi.fn(() => {}),
		warn: vi.fn(() => {}),
		error: vi.fn(() => {}),
		debug: vi.fn(() => {}),
	},
}));

// Import after mocks are set up.
const { awaitConfirmation, onReaction, _pendingSizeForTest } = await import(
	"@/whatsapp/confirm"
);

function makeMsg(chatId = "chat@s.whatsapp.net"): InboundMessage {
	return {
		kind: "whatsapp",
		id: "msg-1",
		chatId,
		senderId: chatId,
		timestamp: new Date(),
		messageKey: {},
	};
}

beforeEach(() => {
	mockSendMessage.mockClear();
	// Reset default implementation to a successful send.
	mockSendMessage.mockImplementation(async () => ({
		key: { id: "sent-msg-id", remoteJid: "chat@s.whatsapp.net", fromMe: true },
	}));
});

describe("awaitConfirmation", () => {
	test("resolves confirmed when reaction arrives", async () => {
		const confirmPromise = awaitConfirmation(makeMsg(), "Confirm this?", 5_000);
		// Flush microtasks so sendMessage awaits complete and pending entry is registered.
		await Promise.resolve();
		onReaction("sent-msg-id", "\ud83d\udc4d");
		expect(await confirmPromise).toBe("confirmed");
	});

	test("resolves rejected when reaction arrives", async () => {
		const confirmPromise = awaitConfirmation(makeMsg(), "Confirm this?", 5_000);
		await Promise.resolve();
		onReaction("sent-msg-id", "\ud83d\udc4e");
		expect(await confirmPromise).toBe("rejected");
	});

	test("ignores unknown emojis — does not consume the pending entry", async () => {
		const confirmPromise = awaitConfirmation(makeMsg(), "Confirm?", 5_000);
		await Promise.resolve();
		onReaction("sent-msg-id", "\ud83e\udd14"); // ignored
		expect(_pendingSizeForTest()).toBe(1); // still pending
		onReaction("sent-msg-id", "\ud83d\udc4d"); // resolve properly
		expect(await confirmPromise).toBe("confirmed");
	});

	test("returns timeout immediately when sendMessage throws", async () => {
		mockSendMessage.mockImplementation(async () => {
			throw new Error("send failed");
		});
		const result = await awaitConfirmation(makeMsg(), "Confirm?", 5_000);
		expect(result).toBe("timeout");
	});

	test("returns timeout immediately when sendMessage returns no key id", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockSendMessage.mockImplementation(
			async () =>
				({ key: { id: null } }) as unknown as Awaited<
					ReturnType<typeof mockSendMessage>
				>,
		);
		const result = await awaitConfirmation(makeMsg(), "Confirm?", 5_000);
		expect(result).toBe("timeout");
	});

	test("pending entry is cleaned up after resolution", async () => {
		const confirmPromise = awaitConfirmation(makeMsg(), "Confirm?", 5_000);
		await Promise.resolve();
		expect(_pendingSizeForTest()).toBe(1);
		onReaction("sent-msg-id", "\ud83d\udc4d");
		await confirmPromise;
		expect(_pendingSizeForTest()).toBe(0);
	});
});

describe("onReaction", () => {
	test("no-op for unknown message ID", () => {
		expect(() => onReaction("unknown-id", "\ud83d\udc4d")).not.toThrow();
	});
});
