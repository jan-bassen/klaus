import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock LiteParse so we don't run an actual PDF parser in unit tests.
const mockParse = mock(async (_input: unknown) => ({
	pages: [],
	text: "  parsed document contents  ",
}));
mock.module("@llamaindex/liteparse", () => ({
	LiteParse: class {
		parse = mockParse;
	},
}));

const { parseDocument, isParseableDocument, _resetParserForTest } =
	await import("@/pipeline/parse-document");

let tmpDir: string;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "parse-doc-test-"));
});

afterAll(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
	mockParse.mockClear();
	_resetParserForTest();
});

describe("isParseableDocument", () => {
	test("returns true for known doc mimes", () => {
		expect(isParseableDocument("application/pdf")).toBe(true);
		expect(
			isParseableDocument(
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			),
		).toBe(true);
	});

	test("returns false for images, text, and unknown types", () => {
		expect(isParseableDocument("image/jpeg")).toBe(false);
		expect(isParseableDocument("text/plain")).toBe(false);
		expect(isParseableDocument("application/zip")).toBe(false);
	});
});

describe("parseDocument", () => {
	test("returns Error for unsupported mime", async () => {
		const filePath = join(tmpDir, "foo.zip");
		await writeFile(filePath, "zipcontent");
		const result = await parseDocument(filePath, "application/zip");
		expect(result).toBeInstanceOf(Error);
	});

	test("parses a document, trims output, and writes sidecar cache", async () => {
		const filePath = join(tmpDir, "doc1.pdf");
		await writeFile(filePath, "fakepdf");

		const result = await parseDocument(filePath, "application/pdf");
		expect(result).toBe("parsed document contents");
		expect(mockParse).toHaveBeenCalledTimes(1);
		expect(existsSync(`${filePath}.parsed.txt`)).toBe(true);
	});

	test("second call reads the sidecar cache instead of re-parsing", async () => {
		const filePath = join(tmpDir, "doc2.pdf");
		await writeFile(filePath, "fakepdf");

		await parseDocument(filePath, "application/pdf");
		expect(mockParse).toHaveBeenCalledTimes(1);

		const second = await parseDocument(filePath, "application/pdf");
		expect(second).toBe("parsed document contents");
		expect(mockParse).toHaveBeenCalledTimes(1); // still 1, not re-parsed
	});

	test("truncates output above maxChars", async () => {
		const filePath = join(tmpDir, "doc3.pdf");
		await writeFile(filePath, "fakepdf");

		const longText = "x".repeat(50_000);
		mockParse.mockImplementationOnce(async () => ({
			pages: [],
			text: longText,
		}));

		const result = await parseDocument(filePath, "application/pdf");
		expect(result).not.toBeInstanceOf(Error);
		const text = result as string;
		expect(text.length).toBeLessThan(longText.length);
		expect(text).toContain("truncated");
	});

	test("returns Error when the parser throws", async () => {
		const filePath = join(tmpDir, "doc4.pdf");
		await writeFile(filePath, "fakepdf");

		mockParse.mockImplementationOnce(async () => {
			throw new Error("parse boom");
		});

		const result = await parseDocument(filePath, "application/pdf");
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("parse boom");
	});
});
