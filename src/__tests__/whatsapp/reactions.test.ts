import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockSendMessage = mock(async () => undefined);

mock.module("@/whatsapp/connection", () => ({
	getSocket: () => ({ sendMessage: mockSendMessage }),
}));

mock.module("@/logger", () => ({
	log: {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
	},
}));

const { sendReaction } = await import("@/whatsapp/reactions");

const msgKey = { id: "msg-1", remoteJid: "chat@s.whatsapp.net", fromMe: false };

beforeEach(() => {
	mockSendMessage.mockClear();
	mockSendMessage.mockImplementation(async () => undefined);
});

describe("sendReaction", () => {
	test("calls sendMessage with react payload", async () => {
		await sendReaction("chat@s.whatsapp.net", msgKey, "👍");
		expect(mockSendMessage).toHaveBeenCalledTimes(1);
		expect(mockSendMessage).toHaveBeenCalledWith("chat@s.whatsapp.net", {
			react: { key: msgKey, text: "👍" },
		});
	});

	test("passes empty string to remove a reaction", async () => {
		await sendReaction("chat@s.whatsapp.net", msgKey, "");
		expect(mockSendMessage).toHaveBeenCalledWith("chat@s.whatsapp.net", {
			react: { key: msgKey, text: "" },
		});
	});

	test("returns Error instead of throwing when sendMessage fails", async () => {
		mockSendMessage.mockImplementation(async () => {
			throw new Error("socket error");
		});
		const result = await sendReaction("chat@s.whatsapp.net", msgKey, "👍");
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toBe("socket error");
	});
});
