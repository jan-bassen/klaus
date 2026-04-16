import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { settings } from "@/config";
import { _resetForTest, _setForTest } from "@/config/schema";
import { textToSpeech } from "@/whatsapp/voice";

describe("textToSpeech", () => {
	let originalKey: string | undefined;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalKey = process.env.ELEVENLABS_API_KEY;
		originalFetch = globalThis.fetch;
		process.env.ELEVENLABS_API_KEY = "test-key";
		// Bundled default ships with an empty voiceId placeholder; tests need a real one.
		_setForTest({
			tts: { ...settings.tts, voiceId: "test-voice-id" },
		});
	});

	afterEach(() => {
		if (originalKey === undefined) {
			delete process.env.ELEVENLABS_API_KEY;
		} else {
			process.env.ELEVENLABS_API_KEY = originalKey;
		}
		globalThis.fetch = originalFetch;
		_resetForTest();
	});

	test("returns Error when ELEVENLABS_API_KEY is not set", async () => {
		delete process.env.ELEVENLABS_API_KEY;
		const result = await textToSpeech("hello");
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("ELEVENLABS_API_KEY");
	});

	test("returns Buffer on success", async () => {
		const mp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
		globalThis.fetch = mock(
			async () => new Response(mp3Bytes.buffer, { status: 200 }),
		) as unknown as typeof fetch;

		const result = await textToSpeech("hello world");
		expect(result).toBeInstanceOf(Buffer);
		expect((result as Buffer).length).toBe(4);
	});

	test("returns Error when API responds with non-OK status", async () => {
		globalThis.fetch = mock(
			async () => new Response("Bad Request", { status: 400 }),
		) as unknown as typeof fetch;

		const result = await textToSpeech("hello");
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("400");
	});

	test("returns Error when fetch throws a network error", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("Connection refused");
		}) as unknown as typeof fetch;

		const result = await textToSpeech("hello");
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toBe("Connection refused");
	});

	test("sends request to the voice-specific URL", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = mock(async (url: string | URL) => {
			capturedUrl = url.toString();
			return new Response(new ArrayBuffer(0), { status: 200 });
		}) as unknown as typeof fetch;

		await textToSpeech("hello");
		expect(capturedUrl).toContain(settings.tts.voiceId);
	});

	test("sends xi-api-key header", async () => {
		let capturedHeaders: Headers | undefined;
		globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
			capturedHeaders = new Headers(init?.headers as Record<string, string>);
			return new Response(new ArrayBuffer(0), { status: 200 });
		}) as unknown as typeof fetch;

		await textToSpeech("hello");
		expect(capturedHeaders?.get("xi-api-key")).toBe("test-key");
	});
});
