/**
 * `pipeline/media.ts` — pure helpers + cache-hit path.
 *
 * Covers `isParseableDocument` mime allowlist, `parseDocument` sidecar cache
 * (hot path that avoids re-running LiteParse), and `prepareImage` downscaling.
 *
 * The network helpers (`transcribe`, `textToSpeech`, `generateImage`) are not
 * exercised here — they hit external APIs and are better covered with a
 * mocked `fetch`/SDK in a separate suite if needed.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isParseableDocument,
	parseDocument,
	prepareImage,
} from "../../src/pipeline/media.ts";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.ts";

describe("pipeline/media: isParseableDocument", () => {
	it("accepts the allowlisted office formats", () => {
		expect(isParseableDocument("application/pdf")).toBe(true);
		expect(
			isParseableDocument(
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			),
		).toBe(true);
		expect(
			isParseableDocument(
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			),
		).toBe(true);
		expect(isParseableDocument("application/msword")).toBe(true);
	});

	it("rejects everything else", () => {
		expect(isParseableDocument("text/plain")).toBe(false);
		expect(isParseableDocument("image/png")).toBe(false);
		expect(isParseableDocument("application/json")).toBe(false);
		expect(isParseableDocument("")).toBe(false);
	});
});

describe("pipeline/media: parseDocument", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = makeTmpDir();
	});

	afterEach(() => {
		rmTmpDir(tmp);
	});

	it("returns an Error for unsupported mime types", async () => {
		const filePath = path.join(tmp, "thing.txt");
		writeFileSync(filePath, "hello");
		const result = await parseDocument(filePath, "text/plain");
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toMatch(/Unsupported mime type/);
	});

	it("returns the cached sidecar text without invoking the parser", async () => {
		const filePath = path.join(tmp, "report.pdf");
		writeFileSync(filePath, "binary garbage that LiteParse would choke on");
		// Pre-seed the sidecar; if the parser ran, it would throw on the bytes
		// above and we'd see an Error rather than the cached payload.
		writeFileSync(`${filePath}.parsed.txt`, "cached body");

		const result = await parseDocument(filePath, "application/pdf");
		expect(result).toBe("cached body");
	});

	it("handles an empty cache file", async () => {
		const filePath = path.join(tmp, "empty.pdf");
		writeFileSync(filePath, "x");
		writeFileSync(`${filePath}.parsed.txt`, "");

		const result = await parseDocument(filePath, "application/pdf");
		expect(result).toBe("");
	});
});

describe("pipeline/media: prepareImage", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = makeTmpDir();
	});

	afterEach(() => {
		rmTmpDir(tmp);
	});

	it("downscales an oversize image to fit within the configured max dimension", async () => {
		const filePath = path.join(tmp, "big.png");
		const big = await sharp({
			create: {
				width: 4000,
				height: 2000,
				channels: 3,
				background: { r: 200, g: 100, b: 50 },
			},
		})
			.png()
			.toBuffer();
		writeFileSync(filePath, big);

		const out = await prepareImage(filePath);
		const meta = await sharp(out).metadata();
		expect(meta.width ?? 0).toBeLessThanOrEqual(2048);
		expect(meta.height ?? 0).toBeLessThanOrEqual(2048);
		expect(meta.width ?? 0).toBeGreaterThan(0);
	});

	it("does not upscale images smaller than the max dimension", async () => {
		const filePath = path.join(tmp, "small.png");
		const small = await sharp({
			create: {
				width: 100,
				height: 80,
				channels: 3,
				background: { r: 0, g: 0, b: 0 },
			},
		})
			.png()
			.toBuffer();
		writeFileSync(filePath, small);

		const out = await prepareImage(filePath);
		const meta = await sharp(out).metadata();
		expect(meta.width).toBe(100);
		expect(meta.height).toBe(80);
	});
});
