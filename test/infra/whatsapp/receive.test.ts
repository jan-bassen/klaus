import type { WAMessage } from "baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../../../src/infra/config.ts";
import { initFilesStore } from "../../../src/infra/store/files.ts";
import { normalizeMessage } from "../../../src/infra/whatsapp/receive.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

const baileysMocks = vi.hoisted(() => ({
	downloadMediaMessage: vi.fn(),
	normalizeMessageContent: vi.fn((message: unknown) => message),
}));

const sendMocks = vi.hoisted(() => ({
	wasSentByUs: vi.fn(),
}));

vi.mock("baileys", () => baileysMocks);

vi.mock("../../../src/pipeline/index.ts", () => ({
	handleTurn: vi.fn(),
}));

vi.mock("../../../src/infra/whatsapp/send.ts", () => ({
	enqueueMessage: vi.fn(),
	setSocket: vi.fn(),
	wasSentByUs: sendMocks.wasSentByUs,
}));

function rawMessage(patch: {
	id?: string;
	chatId?: string;
	senderId?: string;
	fromMe?: boolean;
	message?: Record<string, unknown>;
	timestamp?: number | bigint;
}): WAMessage {
	return {
		key: {
			remoteJid: patch.chatId ?? "chat@s.whatsapp.net",
			id: patch.id ?? "msg-1",
			fromMe: patch.fromMe ?? false,
			participant: patch.senderId,
		},
		message: patch.message,
		messageTimestamp: patch.timestamp ?? 1_700_000_000,
	} as unknown as WAMessage;
}

describe("infra/whatsapp/receive.normalizeMessage", () => {
	let tmpDir: string;
	let originalSelfMode: boolean;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initFilesStore({ dataDir: tmpDir });
		originalSelfMode = settings.whatsapp.selfMode;
		settings.whatsapp.selfMode = false;
		baileysMocks.downloadMediaMessage.mockReset();
		baileysMocks.normalizeMessageContent.mockImplementation(
			(message) => message,
		);
		sendMocks.wasSentByUs.mockReset();
	});

	afterEach(() => {
		settings.whatsapp.selfMode = originalSelfMode;
		rmTmpDir(tmpDir);
	});

	it("normalizes a plain text message", async () => {
		const msg = await normalizeMessage(
			rawMessage({
				id: "text-1",
				senderId: "sender@s.whatsapp.net",
				message: { conversation: "hello" },
			}),
		);

		expect(msg).toMatchObject({
			kind: "whatsapp",
			id: "text-1",
			chatId: "chat@s.whatsapp.net",
			senderId: "sender@s.whatsapp.net",
			text: "hello",
			messageKey: expect.objectContaining({ id: "text-1" }),
		});
		expect(msg?.timestamp.toISOString()).toBe("2023-11-14T22:13:20.000Z");
	});

	it("ignores outbound messages unless self-mode allows them", async () => {
		const outbound = rawMessage({
			fromMe: true,
			message: { conversation: "from me" },
		});
		await expect(normalizeMessage(outbound)).resolves.toBeNull();

		settings.whatsapp.selfMode = true;
		sendMocks.wasSentByUs.mockReturnValue(false);
		await expect(normalizeMessage(outbound)).resolves.toMatchObject({
			text: "from me",
		});

		sendMocks.wasSentByUs.mockReturnValue(true);
		await expect(normalizeMessage(outbound)).resolves.toBeNull();
	});

	it("extracts quoted message context from extended text", async () => {
		const msg = await normalizeMessage(
			rawMessage({
				message: {
					extendedTextMessage: {
						text: "replying",
						contextInfo: {
							stanzaId: "quoted-1",
							quotedMessage: {
								extendedTextMessage: { text: "original" },
							},
						},
					},
				},
			}),
		);

		expect(msg).toMatchObject({
			text: "replying",
			quotedMessage: {
				externalId: "quoted-1",
				text: "original",
			},
		});
	});

	it("downloads image media, persists the blob, and uses the caption as text", async () => {
		baileysMocks.downloadMediaMessage.mockResolvedValue(Buffer.from("image"));

		const msg = await normalizeMessage(
			rawMessage({
				id: "image-1",
				message: {
					imageMessage: {
						mimetype: "image/jpeg; charset=binary",
						caption: "look",
						fileLength: 5,
					},
				},
			}),
		);

		expect(baileysMocks.downloadMediaMessage).toHaveBeenCalledOnce();
		expect(msg).toMatchObject({
			text: "look",
			media: {
				mimeType: "image/jpeg",
			},
		});
		expect(msg?.media?.fileId).toBeTruthy();
		expect(msg?.media?.path).toContain(tmpDir);
	});

	it("downloads sticker media so vision can inspect it", async () => {
		baileysMocks.downloadMediaMessage.mockResolvedValue(Buffer.from("sticker"));

		const msg = await normalizeMessage(
			rawMessage({
				id: "sticker-1",
				message: {
					stickerMessage: {
						mimetype: "image/webp",
						fileLength: 7,
					},
				},
			}),
		);

		expect(baileysMocks.downloadMediaMessage).toHaveBeenCalledOnce();
		expect(msg).toMatchObject({
			media: {
				mimeType: "image/webp",
			},
		});
		expect(msg?.text).toBeUndefined();
		expect(msg?.media?.fileId).toBeTruthy();
		expect(msg?.media?.path).toContain(tmpDir);
	});

	it("keeps document filenames on persisted media", async () => {
		baileysMocks.downloadMediaMessage.mockResolvedValue(Buffer.from("doc"));

		const msg = await normalizeMessage(
			rawMessage({
				message: {
					documentMessage: {
						mimetype: "application/pdf",
						fileName: "brief.pdf",
						caption: "brief",
						fileLength: 3,
					},
				},
			}),
		);

		expect(msg).toMatchObject({
			text: "brief",
			media: {
				mimeType: "application/pdf",
				fileName: "brief.pdf",
			},
		});
	});

	it("adds a voice fallback when a voice note download fails", async () => {
		baileysMocks.downloadMediaMessage.mockRejectedValue(new Error("nope"));

		const msg = await normalizeMessage(
			rawMessage({
				message: {
					audioMessage: {
						mimetype: "audio/ogg",
						ptt: true,
						fileLength: 5,
					},
				},
			}),
		);

		expect(msg).toMatchObject({
			text: "(voice note — could not be downloaded)",
		});
		expect(msg?.media).toBeUndefined();
	});

	it("drops captionless oversized image media when there is no usable content", async () => {
		const msg = await normalizeMessage(
			rawMessage({
				message: {
					imageMessage: {
						mimetype: "image/png",
						fileLength: Number.MAX_SAFE_INTEGER,
					},
				},
			}),
		);

		expect(msg).toBeNull();
		expect(baileysMocks.downloadMediaMessage).not.toHaveBeenCalled();
	});
});
