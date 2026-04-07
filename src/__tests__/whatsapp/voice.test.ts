import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { settings } from "@/settings";
import { transcribe } from "@/whatsapp/voice";

let tmpDir: string;
let fakeAudioPath: string;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "voice-test-"));
	fakeAudioPath = join(tmpDir, "test.ogg");
	// voice.ts does blob.arrayBuffer() outside its try-catch, so the file must exist
	await writeFile(fakeAudioPath, Buffer.from([0x4f, 0x67, 0x67, 0x53])); // OGG magic bytes
});

afterAll(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("transcribe", () => {
	let originalKey: string | undefined;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalKey = process.env.ELEVENLABS_API_KEY;
		originalFetch = globalThis.fetch;
		process.env.ELEVENLABS_API_KEY = "test-key";
	});

	afterEach(() => {
		if (originalKey === undefined) {
			delete process.env.ELEVENLABS_API_KEY;
		} else {
			process.env.ELEVENLABS_API_KEY = originalKey;
		}
		globalThis.fetch = originalFetch;
	});

	test("returns Error when ELEVENLABS_API_KEY is not set", async () => {
		delete process.env.ELEVENLABS_API_KEY;
		const result = await transcribe(fakeAudioPath, "audio/ogg");
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("ELEVENLABS_API_KEY");
	});

	test("returns transcript string on success", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ text: "hello world" }), { status: 200 }),
		) as unknown as typeof fetch;

		const result = await transcribe(fakeAudioPath, "audio/ogg");
		expect(result).toBe("hello world");
	});

	test("returns empty string when response has no text field", async () => {
		globalThis.fetch = mock(
			async () => new Response(JSON.stringify({}), { status: 200 }),
		) as unknown as typeof fetch;

		const result = await transcribe(fakeAudioPath, "audio/ogg");
		expect(result).toBe("");
	});

	test("returns Error when API responds with non-OK status", async () => {
		globalThis.fetch = mock(
			async () => new Response("Unauthorized", { status: 401 }),
		) as unknown as typeof fetch;

		const result = await transcribe(fakeAudioPath, "audio/ogg");
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("401");
	});

	test("returns Error when fetch throws a network error", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("Network failure");
		}) as unknown as typeof fetch;

		const result = await transcribe(fakeAudioPath, "audio/ogg");
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toBe("Network failure");
	});

	test("returns Error when transcription API times out", async () => {
		const original = settings.stt.timeoutMs;
		(settings.stt as { timeoutMs: number }).timeoutMs = 50;

		globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
			return new Promise<Response>((resolve, reject) => {
				const timer = setTimeout(
					() => resolve(new Response("late", { status: 200 })),
					5_000,
				);
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(init.signal?.reason ?? new Error("aborted"));
				});
			});
		}) as unknown as typeof fetch;

		try {
			const result = await transcribe(fakeAudioPath, "audio/ogg");
			expect(result).toBeInstanceOf(Error);
			expect((result as Error).message).toMatch(/abort|timed? ?out/i);
		} finally {
			(settings.stt as { timeoutMs: number }).timeoutMs = original;
		}
	});

	test("sends xi-api-key header with the configured API key", async () => {
		let capturedHeaders: Headers | undefined;
		globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
			capturedHeaders = new Headers(init?.headers as Record<string, string>);
			return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
		}) as unknown as typeof fetch;

		await transcribe(fakeAudioPath, "audio/ogg");
		expect(capturedHeaders?.get("xi-api-key")).toBe("test-key");
	});
});
