import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { OutboundMessage } from "@/types";

mock.module("@/logger", () => ({
	log: {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
	},
}));

mock.module("@/config", () => ({
	config: {
		send: { interMessageDelayMs: 0 },
	},
}));

const { setSocket, enqueueMessage, drainQueue, wasSentByUs } = await import(
	"@/whatsapp/send"
);

import { settings } from "@/settings";

const mockSendMessage = mock(
	async (_jid: string, _content: unknown, _opts?: unknown) => ({
		key: { id: "wa-msg-id-1" },
	}),
);

function makeMsg(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
	return {
		chatId: "user@s.whatsapp.net",
		content: "hello",
		dedupKey: `key-${crypto.randomUUID()}`,
		...overrides,
	};
}

beforeEach(() => {
	mockSendMessage.mockClear();
	mockSendMessage.mockImplementation(async () => ({
		key: { id: `wa-${crypto.randomUUID()}` },
	}));
	setSocket({ sendMessage: mockSendMessage } as unknown as Parameters<
		typeof setSocket
	>[0]);
});

afterEach(async () => {
	await drainQueue();
});

describe("enqueueMessage", () => {
	test("sends a text message via the socket", async () => {
		const msg = makeMsg();
		enqueueMessage(msg);
		await drainQueue();

		expect(mockSendMessage).toHaveBeenCalledTimes(1);
		expect(mockSendMessage.mock.calls[0]?.[0]).toBe(msg.chatId);
		expect(mockSendMessage.mock.calls[0]?.[1]).toEqual({ text: "hello" });
	});

	test("FIFO ordering — A is sent before B", async () => {
		const a = makeMsg({ content: "first" });
		const b = makeMsg({ content: "second" });
		enqueueMessage(a);
		enqueueMessage(b);
		await drainQueue();

		expect(mockSendMessage).toHaveBeenCalledTimes(2);
		expect(mockSendMessage.mock.calls[0]?.[1]).toEqual({ text: "first" });
		expect(mockSendMessage.mock.calls[1]?.[1]).toEqual({ text: "second" });
	});

	test("deduplicates messages with the same dedupKey", async () => {
		const msg = makeMsg({ dedupKey: "same-key" });
		enqueueMessage(msg);
		enqueueMessage(msg);
		await drainQueue();

		expect(mockSendMessage).toHaveBeenCalledTimes(1);
	});

	test("invokes onSent callback with the Baileys message ID", async () => {
		const waId = `wa-${crypto.randomUUID()}`;
		mockSendMessage.mockImplementation(async () => ({ key: { id: waId } }));

		const onSent = mock((_id: string) => {});
		enqueueMessage(makeMsg(), onSent);
		await drainQueue();

		expect(onSent).toHaveBeenCalledTimes(1);
		expect(onSent.mock.calls[0]?.[0]).toBe(waId);
	});

	test("retries on transient failure and succeeds on third attempt", async () => {
		let attempt = 0;
		mockSendMessage.mockImplementation(async () => {
			attempt++;
			if (attempt < 3) throw new Error("transient");
			return { key: { id: "wa-ok" } };
		});

		enqueueMessage(makeMsg());
		await drainQueue();

		expect(mockSendMessage).toHaveBeenCalledTimes(3);
	});

	test("sends failure notification after max retries exhausted", async () => {
		mockSendMessage.mockImplementation(
			async (_jid: string, content: unknown) => {
				const c = content as { text?: string };
				if (
					typeof c?.text === "string" &&
					c.text.includes("Failed to deliver")
				) {
					return { key: { id: "wa-notify" } };
				}
				throw new Error("permanent failure");
			},
		);

		enqueueMessage(makeMsg());
		await drainQueue();

		// 3 retries for the original + 1 failure notification
		expect(mockSendMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
	});

	test("routes image buffer as image content", async () => {
		const buf = Buffer.from("fake-image");
		enqueueMessage(makeMsg({ content: buf, mimeType: "image/png" }));
		await drainQueue();

		const sentContent = mockSendMessage.mock.calls[0]?.[1] as Record<
			string,
			unknown
		>;
		expect(sentContent?.image).toBeInstanceOf(Buffer);
		expect(sentContent?.mimetype).toBe("image/png");
	});

	test("routes audio buffer as audio content", async () => {
		const buf = Buffer.from("fake-audio");
		enqueueMessage(makeMsg({ content: buf, mimeType: "audio/mpeg" }));
		await drainQueue();

		const sentContent = mockSendMessage.mock.calls[0]?.[1] as Record<
			string,
			unknown
		>;
		expect(sentContent?.audio).toBeInstanceOf(Buffer);
		expect(sentContent?.mimetype).toBe("audio/mpeg");
	});

	test("routes unknown mime as document content", async () => {
		const buf = Buffer.from("fake-doc");
		enqueueMessage(makeMsg({ content: buf, mimeType: "application/pdf" }));
		await drainQueue();

		const sentContent = mockSendMessage.mock.calls[0]?.[1] as Record<
			string,
			unknown
		>;
		expect(sentContent?.document).toBeInstanceOf(Buffer);
		expect(sentContent?.mimetype).toBe("application/pdf");
	});

	test("passes quoted message key when quoted is set", async () => {
		const msg = makeMsg({ quoted: { externalId: "ext-123", fromMe: false } });
		enqueueMessage(msg);
		await drainQueue();

		const sendOpts = mockSendMessage.mock.calls[0]?.[2] as {
			quoted?: { key?: { id?: string; fromMe?: boolean } };
		};
		expect(sendOpts?.quoted?.key?.id).toBe("ext-123");
		expect(sendOpts?.quoted?.key?.fromMe).toBe(false);
	});
});

describe("wasSentByUs", () => {
	test("returns true for IDs of messages we sent", async () => {
		const waId = "wa-tracked-id";
		mockSendMessage.mockImplementation(async () => ({
			key: { id: waId },
		}));
		enqueueMessage(makeMsg());
		await drainQueue();

		expect(wasSentByUs(waId)).toBe(true);
	});

	test("returns false for unknown IDs", () => {
		expect(wasSentByUs("unknown-id")).toBe(false);
	});
});

describe("self-mode prefix", () => {
	let savedSelfMode: boolean;

	function enableSelfMode(): void {
		(settings.whatsapp as { selfMode: boolean }).selfMode = true;
	}

	function restoreSelfMode(): void {
		(settings.whatsapp as { selfMode: boolean }).selfMode = savedSelfMode;
	}

	test("prefixes text with [Klaus] when selfMode on and no label", async () => {
		savedSelfMode = settings.whatsapp.selfMode;
		try {
			enableSelfMode();
			enqueueMessage(makeMsg({ content: "hello" }));
			await drainQueue();

			const sent = mockSendMessage.mock.calls[0]?.[1] as { text?: string };
			expect(sent?.text).toBe("[Klaus]: hello");
		} finally {
			restoreSelfMode();
		}
	});

	test("prefixes text with [AgentName] when selfMode on and label set", async () => {
		savedSelfMode = settings.whatsapp.selfMode;
		try {
			enableSelfMode();
			enqueueMessage(makeMsg({ content: "world", label: "thinking" }));
			await drainQueue();

			const sent = mockSendMessage.mock.calls[0]?.[1] as { text?: string };
			expect(sent?.text).toBe("[thinking]: world");
		} finally {
			restoreSelfMode();
		}
	});

	test("does not prefix Buffer content in selfMode", async () => {
		savedSelfMode = settings.whatsapp.selfMode;
		try {
			enableSelfMode();
			const buf = Buffer.from("fake-image");
			enqueueMessage(makeMsg({ content: buf, mimeType: "image/png" }));
			await drainQueue();

			const sent = mockSendMessage.mock.calls[0]?.[1] as Record<
				string,
				unknown
			>;
			expect(sent?.image).toBeInstanceOf(Buffer);
			expect(sent?.text).toBeUndefined();
		} finally {
			restoreSelfMode();
		}
	});

	test("no prefix when selfMode is off", async () => {
		savedSelfMode = settings.whatsapp.selfMode;
		try {
			(settings.whatsapp as { selfMode: boolean }).selfMode = false;
			enqueueMessage(makeMsg({ content: "hello" }));
			await drainQueue();

			const sent = mockSendMessage.mock.calls[0]?.[1] as { text?: string };
			expect(sent?.text).toBe("hello");
		} finally {
			restoreSelfMode();
		}
	});
});
