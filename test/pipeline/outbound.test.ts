import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConversation } from "../../src/infra/store/history.ts";
import type { InboundMessage } from "../../src/infra/whatsapp/receive.ts";
import {
	makeDedupKey,
	prepareAssistantOutbound,
} from "../../src/pipeline/outbound.ts";
import { initAllStores } from "../helpers/stores.ts";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.ts";
import { makeTurn } from "../helpers/turn.ts";

function inbound(id: string): InboundMessage {
	return {
		kind: "whatsapp",
		id,
		chatId: "c1",
		senderId: "sender",
		text: "hello",
		timestamp: new Date(),
		messageKey: { remoteJid: "c1", fromMe: false, id },
	};
}

describe("pipeline/outbound: makeDedupKey", () => {
	it("includes message id and kind when inbound message is present", () => {
		const turn = makeTurn({ message: inbound("msg-1") });
		const key = makeDedupKey(turn, "reply");
		expect(key).toMatch(/^msg-1:reply:/);
	});

	it("includes chatId and kind when no inbound message", () => {
		const turn = makeTurn();
		delete turn.message;
		const key = makeDedupKey(turn, "dispatch");
		expect(key).toMatch(/^c1:dispatch:/);
	});

	it("appends a unique UUID suffix for deduplication", () => {
		const turn = makeTurn({ message: inbound("msg-x") });
		const k1 = makeDedupKey(turn, "reply");
		const k2 = makeDedupKey(turn, "reply");
		expect(k1).not.toBe(k2);
	});
});

describe("pipeline/outbound: prepareAssistantOutbound — message persistence", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("persists assistant message and returns a dedupKey", async () => {
		const turn = makeTurn({
			message: inbound("msg-1"),
			config: {},
		});
		const result = await prepareAssistantOutbound({
			context: turn,
			content: "Hello there",
			kind: "reply",
			logPrefix: "[test]",
		});

		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;

		expect(result.dedupKey).toMatch(/^msg-1:reply:/);

		const conv = await getConversation();
		const assistant = conv.find((m) => m.role === "assistant");
		expect(assistant?.content).toBe("Hello there");
		expect(assistant?.agent).toBe("test");
	});

	it("skips persistence when ghost mode is enabled", async () => {
		const turn = makeTurn({
			message: inbound("msg-ghost"),
			config: { ghost: true },
		});
		await prepareAssistantOutbound({
			context: turn,
			content: "ghost reply",
			kind: "reply",
			logPrefix: "[test]",
		});

		const conv = await getConversation();
		expect(conv).toHaveLength(0);
	});

	it("returns error for unknown messageRef label", async () => {
		const turn = makeTurn({
			message: inbound("msg-x"),
			messageRefs: {},
		});
		const result = await prepareAssistantOutbound({
			context: turn,
			content: "reply",
			kind: "reply",
			logPrefix: "[test]",
			messageRef: "99",
		});

		expect(result).toHaveProperty("error");
	});

	it("resolves numbered message refs from history", async () => {
		const turn = makeTurn({
			message: inbound("msg-x"),
			messageRefs: {
				"2": { externalId: "older-assistant", role: "assistant" },
			},
		});
		const result = await prepareAssistantOutbound({
			context: turn,
			content: "reply",
			kind: "reply",
			logPrefix: "[test]",
			messageRef: "2",
		});

		expect(result).not.toHaveProperty("error");
		if ("error" in result) return;
		expect(result.quoted).toEqual({
			externalId: "older-assistant",
			fromMe: true,
		});
	});
});
