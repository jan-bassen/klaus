import type { WAMessage } from "@whiskeysockets/baileys";
import { describe, expect, test, vi } from "vitest";

const { downloadMediaMessageMock, mockWasSentByUs } = vi.hoisted(() => ({
	downloadMediaMessageMock: vi.fn(async () => {
		throw new Error("no real socket");
	}),
	mockWasSentByUs: vi.fn((_id: string) => false),
}));

// Mock downloadMediaMessage to control download behavior in tests
vi.mock("@whiskeysockets/baileys", () => ({
	downloadMediaMessage: downloadMediaMessageMock,
	normalizeMessageContent: (m: Record<string, unknown>) =>
		(m as { ephemeralMessage?: { message?: unknown } }).ephemeralMessage
			?.message ?? m,
}));
vi.mock("@/store/files", () => ({
	saveFileMeta: vi.fn(async () => ({ id: "file-id" })),
}));

vi.mock("@/whatsapp/send", () => ({
	enqueueMessage: vi.fn(() => {}),
	setSocket: vi.fn(() => {}),
	wasSentByUs: mockWasSentByUs,
}));

import { settings } from "@/config";
import { normalizeMessage } from "@/whatsapp/receive";

function makeRaw(overrides: Record<string, unknown> = {}): WAMessage {
	return {
		key: {
			remoteJid: "user@s.whatsapp.net",
			fromMe: false,
			id: "ABC123",
			participant: null,
		},
		message: {
			conversation: "Hello Klaus!",
		},
		messageTimestamp: 1_700_000_000,
		...overrides,
	};
}

describe("normalizeMessage", () => {
	test("returns InboundMessage for a simple text message", async () => {
		const result = await normalizeMessage(makeRaw());
		expect(result).not.toBeNull();
		expect(result?.text).toBe("Hello Klaus!");
		expect(result?.chatId).toBe("user@s.whatsapp.net");
	});

	test("skips messages sent by us (fromMe = true)", async () => {
		const result = await normalizeMessage(
			makeRaw({
				key: { remoteJid: "user@s.whatsapp.net", fromMe: true, id: "X" },
			}),
		);
		expect(result).toBeNull();
	});

	test("skips messages without a remoteJid", async () => {
		const result = await normalizeMessage(
			makeRaw({ key: { remoteJid: undefined, fromMe: false, id: "X" } }),
		);
		expect(result).toBeNull();
	});

	test("skips messages without a message field", async () => {
		const result = await normalizeMessage(makeRaw({ message: undefined }));
		expect(result).toBeNull();
	});

	test("skips non-text messages that fail to download (e.g. image-only with no real socket)", async () => {
		const result = await normalizeMessage(
			makeRaw({
				message: { imageMessage: { url: "https://example.com/img.jpg" } },
			}),
		);
		expect(result).toBeNull();
	});

	test("extracts text from extendedTextMessage", async () => {
		const result = await normalizeMessage(
			makeRaw({
				message: { extendedTextMessage: { text: "Quoted reply text" } },
			}),
		);
		expect(result).not.toBeNull();
		expect(result?.text).toBe("Quoted reply text");
	});

	test("converts messageTimestamp (seconds) to a Date", async () => {
		const result = await normalizeMessage(
			makeRaw({ messageTimestamp: 1_700_000_000 }),
		);
		expect(result).not.toBeNull();
		expect(result?.timestamp).toBeInstanceOf(Date);
		expect(result?.timestamp.getTime()).toBe(1_700_000_000 * 1000);
	});

	test("handles bigint messageTimestamp", async () => {
		const result = await normalizeMessage(
			makeRaw({ messageTimestamp: BigInt(1_700_000_000) }),
		);
		expect(result).not.toBeNull();
		expect(result?.timestamp.getTime()).toBe(1_700_000_000 * 1000);
	});

	test("uses key.id as the message id", async () => {
		const result = await normalizeMessage(makeRaw());
		expect(result?.id).toBe("ABC123");
	});

	test("falls back to crypto.randomUUID when key.id is missing", async () => {
		const result = await normalizeMessage(
			makeRaw({
				key: { remoteJid: "user@s.whatsapp.net", fromMe: false, id: undefined },
			}),
		);
		expect(result).not.toBeNull();
		expect(result?.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("uses participant as senderId in group messages", async () => {
		const result = await normalizeMessage(
			makeRaw({
				key: {
					remoteJid: "group@g.us",
					fromMe: false,
					id: "X",
					participant: "member@s.whatsapp.net",
				},
			}),
		);
		expect(result?.senderId).toBe("member@s.whatsapp.net");
	});

	test("falls back to remoteJid as senderId in 1:1 messages", async () => {
		const result = await normalizeMessage(makeRaw());
		expect(result?.senderId).toBe("user@s.whatsapp.net");
	});
});

describe("normalizeMessage — media download timeout", () => {
	test("produces voice note fallback when media download times out", async () => {
		const original = settings.whatsapp.mediaDownloadTimeoutMs;
		(
			settings.whatsapp as { mediaDownloadTimeoutMs: number }
		).mediaDownloadTimeoutMs = 50;

		downloadMediaMessageMock.mockImplementationOnce(
			() => new Promise((resolve) => setTimeout(resolve, 5_000)),
		);

		try {
			const result = await normalizeMessage(
				makeRaw({
					message: {
						audioMessage: {
							mimetype: "audio/ogg",
							ptt: true,
							fileLength: 1024,
						},
					},
				}),
			);

			expect(result).not.toBeNull();
			expect(result?.text).toBe("(voice note — could not be downloaded)");
			expect(result?.media).toBeUndefined();
		} finally {
			(
				settings.whatsapp as { mediaDownloadTimeoutMs: number }
			).mediaDownloadTimeoutMs = original;
		}
	});
});

describe("normalizeMessage — quoted messages", () => {
	function makeReply(
		quotedMessage: Record<string, unknown>,
		participant = "other@s.whatsapp.net",
	) {
		return makeRaw({
			message: {
				extendedTextMessage: {
					text: "My reply",
					contextInfo: {
						stanzaId: "original-msg-id",
						participant,
						quotedMessage,
					},
				},
			},
		});
	}

	test("extracts quotedMessage when replying to a message", async () => {
		const result = await normalizeMessage(
			makeReply({ conversation: "Original text" }),
		);
		expect(result).not.toBeNull();
		expect(result?.quotedMessage).toEqual({
			externalId: "original-msg-id",
			text: "Original text",
		});
	});

	test("extracts quotedMessage for extendedTextMessage replies", async () => {
		const result = await normalizeMessage(
			makeReply({
				extendedTextMessage: { text: "Nested quoted text" },
			}),
		);
		expect(result?.quotedMessage).toEqual({
			externalId: "original-msg-id",
			text: "Nested quoted text",
		});
	});

	test.each([
		["image", { imageMessage: { caption: "Nice photo" } }],
		["audio", { audioMessage: {} }],
		[
			"document",
			{ documentMessage: { fileName: "report.pdf", caption: "Q3 report" } },
		],
		["empty/unknown", {}],
	] as const)("extracts quotedMessage when replying to %s", async (_type, quotedMessage) => {
		const result = await normalizeMessage(makeReply(quotedMessage));
		expect(result?.quotedMessage).toEqual({ externalId: "original-msg-id" });
	});

	test("does not set quotedMessage when stanzaId is missing", async () => {
		const result = await normalizeMessage(
			makeRaw({
				message: {
					extendedTextMessage: {
						text: "A reply",
						contextInfo: {
							participant: "other@s.whatsapp.net",
							quotedMessage: { conversation: "hi" },
						},
					},
				},
			}),
		);
		expect(result?.quotedMessage).toBeUndefined();
	});

	test("does not set quotedMessage for plain conversation messages", async () => {
		const result = await normalizeMessage(makeRaw());
		expect(result?.quotedMessage).toBeUndefined();
	});

	test("extracts text and quotedMessage from an ephemeral-wrapped reply", async () => {
		const result = await normalizeMessage(
			makeRaw({
				message: {
					ephemeralMessage: {
						message: {
							extendedTextMessage: {
								text: "My reply",
								contextInfo: {
									stanzaId: "orig-id",
									participant: "other@s.whatsapp.net",
									quotedMessage: { conversation: "Original" },
								},
							},
						},
					},
				},
			}),
		);
		expect(result).not.toBeNull();
		expect(result?.text).toBe("My reply");
		expect(result?.quotedMessage).toEqual({
			externalId: "orig-id",
			text: "Original",
		});
	});

	test("passes through a quote-only reply with no extra text", async () => {
		const result = await normalizeMessage(
			makeRaw({
				message: {
					extendedTextMessage: {
						contextInfo: {
							stanzaId: "orig-id",
							participant: "other@s.whatsapp.net",
							quotedMessage: { conversation: "Original" },
						},
					},
				},
			}),
		);
		expect(result).not.toBeNull();
		expect(result?.text).toBeUndefined();
		expect(result?.quotedMessage).toEqual({
			externalId: "orig-id",
			text: "Original",
		});
	});
});

describe("normalizeMessage — self-mode", () => {
	let savedSelfMode: boolean;

	function enableSelfMode(): void {
		(settings.whatsapp as { selfMode: boolean }).selfMode = true;
	}

	function disableSelfMode(): void {
		(settings.whatsapp as { selfMode: boolean }).selfMode = savedSelfMode;
	}

	test("selfMode off: fromMe messages are still skipped", async () => {
		savedSelfMode = settings.whatsapp.selfMode;
		try {
			disableSelfMode();
			const result = await normalizeMessage(
				makeRaw({
					key: { remoteJid: "user@s.whatsapp.net", fromMe: true, id: "X" },
				}),
			);
			expect(result).toBeNull();
		} finally {
			disableSelfMode();
		}
	});

	test("selfMode on + wasSentByUs=true: skips our own replies", async () => {
		savedSelfMode = settings.whatsapp.selfMode;
		try {
			enableSelfMode();
			mockWasSentByUs.mockImplementation(() => true);
			const result = await normalizeMessage(
				makeRaw({
					key: {
						remoteJid: "user@s.whatsapp.net",
						fromMe: true,
						id: "our-reply-id",
					},
				}),
			);
			expect(result).toBeNull();
		} finally {
			disableSelfMode();
			mockWasSentByUs.mockImplementation(() => false);
		}
	});

	test("selfMode on + wasSentByUs=false: processes user self-messages", async () => {
		savedSelfMode = settings.whatsapp.selfMode;
		try {
			enableSelfMode();
			mockWasSentByUs.mockImplementation(() => false);
			const result = await normalizeMessage(
				makeRaw({
					key: {
						remoteJid: "user@s.whatsapp.net",
						fromMe: true,
						id: "user-self-msg",
					},
				}),
			);
			expect(result).not.toBeNull();
			expect(result?.text).toBe("Hello Klaus!");
			expect(result?.id).toBe("user-self-msg");
		} finally {
			disableSelfMode();
			mockWasSentByUs.mockImplementation(() => false);
		}
	});
});
