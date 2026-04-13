import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkAllowlist } from "@/pipeline";
import type { InboundMessage } from "@/types";

function makeMsg(chatId = "123@s.whatsapp.net"): InboundMessage {
	return {
		kind: "whatsapp",
		id: "msg-1",
		chatId,
		senderId: chatId,
		text: "hello",
		timestamp: new Date(),
		messageKey: {},
	};
}

describe("checkAllowlist", () => {
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env.ALLOWED_CHAT_ID;
	});
	afterEach(() => {
		if (saved !== undefined) process.env.ALLOWED_CHAT_ID = saved;
		else delete process.env.ALLOWED_CHAT_ID;
	});

	test("returns setupMode when ALLOWED_CHAT_ID is empty", () => {
		delete process.env.ALLOWED_CHAT_ID;
		const result = checkAllowlist(makeMsg());
		expect(result.allowed).toBe(false);
		expect(result.setupMode).toBe(true);
	});

	test("returns allowed:false without setupMode on mismatch", () => {
		process.env.ALLOWED_CHAT_ID = "other@s.whatsapp.net";
		const result = checkAllowlist(makeMsg());
		expect(result.allowed).toBe(false);
		expect(result.setupMode).toBeUndefined();
	});

	test("returns allowed:true on match", () => {
		process.env.ALLOWED_CHAT_ID = "123@s.whatsapp.net";
		const result = checkAllowlist(makeMsg());
		expect(result.allowed).toBe(true);
	});
});
