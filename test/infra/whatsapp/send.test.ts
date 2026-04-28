/**
 * `infra/whatsapp/send.ts` — outbound queue, dedup, retry, label prefixing.
 *
 * The module owns mutable singleton state (queue chain, dedup set, sent-id
 * cache), so each test re-imports it via `vi.resetModules()` for isolation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "@/infra/config";
import * as send from "@/infra/whatsapp/send";

interface MockSocket {
	sendMessage: ReturnType<typeof vi.fn>;
}

function makeSocket(): MockSocket {
	return {
		sendMessage: vi.fn().mockResolvedValue({ key: { id: "wa-1" } }),
	};
}

function attach(socket: MockSocket): typeof send {
	send.setSocket(socket as unknown as Parameters<typeof send.setSocket>[0]);
	return send;
}

describe("infra/whatsapp/send", () => {
	let savedSelfMode: boolean;
	let savedSendDelay: number;
	let savedRetries: typeof settings.whatsapp.retries;

	beforeEach(() => {
		savedSelfMode = settings.whatsapp.selfMode;
		savedSendDelay = settings.whatsapp.sendDelay;
		savedRetries = { ...settings.whatsapp.retries };
		settings.whatsapp.sendDelay = 0;
	});

	afterEach(() => {
		settings.whatsapp.selfMode = savedSelfMode;
		settings.whatsapp.sendDelay = savedSendDelay;
		settings.whatsapp.retries = savedRetries;
	});

	it("delivers a single text message", async () => {
		const sock = makeSocket();
		const mod = attach(sock);

		mod.enqueueMessage({
			chatId: "c1",
			content: "hello",
			dedupKey: "k-deliver",
		});
		await mod.drainQueue();

		expect(sock.sendMessage).toHaveBeenCalledTimes(1);
		expect(sock.sendMessage).toHaveBeenCalledWith(
			"c1",
			{ text: "hello" },
			undefined,
		);
	});

	it("dedups messages with the same key", async () => {
		const sock = makeSocket();
		const mod = attach(sock);

		mod.enqueueMessage({ chatId: "c1", content: "a", dedupKey: "k-dup" });
		mod.enqueueMessage({ chatId: "c1", content: "a-again", dedupKey: "k-dup" });
		await mod.drainQueue();

		expect(sock.sendMessage).toHaveBeenCalledTimes(1);
		expect(sock.sendMessage.mock.calls[0]?.[1]).toEqual({ text: "a" });
	});

	it("preserves FIFO order across enqueues", async () => {
		const sock = makeSocket();
		// Inject artificial latency so out-of-order would be visible.
		sock.sendMessage.mockImplementation(async () => {
			await new Promise((r) => setTimeout(r, 5));
			return { key: { id: "wa" } };
		});
		const mod = attach(sock);

		mod.enqueueMessage({ chatId: "c1", content: "1", dedupKey: "k-fifo-1" });
		mod.enqueueMessage({ chatId: "c1", content: "2", dedupKey: "k-fifo-2" });
		mod.enqueueMessage({ chatId: "c1", content: "3", dedupKey: "k-fifo-3" });
		await mod.drainQueue();

		const sent = sock.sendMessage.mock.calls.map(
			(c) => (c[1] as { text: string }).text,
		);
		expect(sent).toEqual(["1", "2", "3"]);
	});

	it("self-mode prefixes text with the provided label", async () => {
		const sock = makeSocket();
		settings.whatsapp.selfMode = true;
		const mod = attach(sock);

		mod.enqueueMessage({
			chatId: "c1",
			content: "hi",
			dedupKey: "k-label",
			label: "coach",
		});
		await mod.drainQueue();

		expect(sock.sendMessage.mock.calls[0]?.[1]).toEqual({ text: "[coach]: hi" });
	});

	it("self-mode falls back to [Klaus] when no label", async () => {
		const sock = makeSocket();
		settings.whatsapp.selfMode = true;
		const mod = attach(sock);

		mod.enqueueMessage({
			chatId: "c1",
			content: "hi",
			dedupKey: "k-default-label",
		});
		await mod.drainQueue();

		expect(sock.sendMessage.mock.calls[0]?.[1]).toEqual({ text: "[Klaus]: hi" });
	});

	it("does NOT prefix when self-mode is off", async () => {
		const sock = makeSocket();
		settings.whatsapp.selfMode = false;
		const mod = attach(sock);

		mod.enqueueMessage({
			chatId: "c1",
			content: "hi",
			dedupKey: "k-no-prefix",
			label: "coach",
		});
		await mod.drainQueue();

		expect(sock.sendMessage.mock.calls[0]?.[1]).toEqual({ text: "hi" });
	});

	it("buffer content routes to image/audio/video/document by mime", async () => {
		const sock = makeSocket();
		const mod = attach(sock);

		mod.enqueueMessage({
			chatId: "c1",
			content: Buffer.from("img"),
			mimeType: "image/png",
			dedupKey: "k-img",
		});
		mod.enqueueMessage({
			chatId: "c1",
			content: Buffer.from("aud"),
			mimeType: "audio/mpeg",
			dedupKey: "k-aud",
		});
		mod.enqueueMessage({
			chatId: "c1",
			content: Buffer.from("doc"),
			mimeType: "application/pdf",
			dedupKey: "k-doc",
		});
		await mod.drainQueue();

		const types = sock.sendMessage.mock.calls.map(
			(c) => Object.keys(c[1] as object)[0],
		);
		expect(types).toEqual(["image", "audio", "document"]);
	});

	it("retries on failure up to settings.whatsapp.retries.max", async () => {
		const sock = makeSocket();
		settings.whatsapp.retries = { max: 3, backoffMs: 0 };
		sock.sendMessage
			.mockRejectedValueOnce(new Error("boom"))
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce({ key: { id: "wa-final" } });
		const mod = attach(sock);

		mod.enqueueMessage({
			chatId: "c1",
			content: "retry-me",
			dedupKey: "k-retry",
		});
		await mod.drainQueue();

		expect(sock.sendMessage).toHaveBeenCalledTimes(3);
	});

	it("invokes onSent with the WA id after delivery", async () => {
		const sock = makeSocket();
		sock.sendMessage.mockResolvedValueOnce({ key: { id: "wa-id-42" } });
		const mod = attach(sock);
		const onSent = vi.fn();

		mod.enqueueMessage(
			{ chatId: "c1", content: "x", dedupKey: "k-onsent" },
			onSent,
		);
		await mod.drainQueue();

		expect(onSent).toHaveBeenCalledWith("wa-id-42");
	});

	it("wasSentByUs tracks delivered message IDs", async () => {
		const sock = makeSocket();
		sock.sendMessage.mockResolvedValueOnce({ key: { id: "wa-tracked" } });
		const mod = attach(sock);

		mod.enqueueMessage({ chatId: "c1", content: "x", dedupKey: "k-track" });
		await mod.drainQueue();

		expect(mod.wasSentByUs("wa-tracked")).toBe(true);
		expect(mod.wasSentByUs("not-ours")).toBe(false);
	});

	it("attaches a quoted reply when msg.quoted is set", async () => {
		const sock = makeSocket();
		const mod = attach(sock);

		mod.enqueueMessage({
			chatId: "c1",
			content: "reply",
			dedupKey: "k-quote",
			quoted: { externalId: "m-orig", fromMe: false },
		});
		await mod.drainQueue();

		const opts = sock.sendMessage.mock.calls[0]?.[2] as {
			quoted: { key: { remoteJid: string; id: string; fromMe: boolean } };
		};
		expect(opts.quoted.key).toEqual({
			remoteJid: "c1",
			id: "m-orig",
			fromMe: false,
		});
	});
});
