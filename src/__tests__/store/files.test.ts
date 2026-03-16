import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let savedDataDir: string | undefined;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "files-test-"));
	savedDataDir = process.env.DATA_DIR;
	process.env.DATA_DIR = tmpDir;
});

afterAll(async () => {
	if (savedDataDir !== undefined) process.env.DATA_DIR = savedDataDir;
	else delete process.env.DATA_DIR;
	await rm(tmpDir, { recursive: true, force: true });
});

const {
	saveFileMeta,
	findFile,
	findFileByMessageId,
	listFiles,
	deleteFile,
	updateFileMessageId,
	rebuildFileIndex,
	_clearFileIndexForTest,
} = await import("@/store/files");

beforeEach(() => {
	_clearFileIndexForTest();
});

describe("saveFileMeta", () => {
	test("returns id and path, file is retrievable", async () => {
		const result = await saveFileMeta({
			path: "/tmp/test.txt",
			mimeType: "text/plain",
			sizeBytes: 100,
		});
		expect(result).not.toBeInstanceOf(Error);
		const saved = result as { id: string; path: string };
		expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);

		const found = findFile(saved.id);
		expect(found).not.toBeNull();
		expect(found?.mimeType).toBe("text/plain");
		expect(found?.sizeBytes).toBe(100);
	});
});

describe("updateFileMessageId", () => {
	test("backfills messageId on existing file", async () => {
		const result = await saveFileMeta({
			path: "/tmp/a.jpg",
			mimeType: "image/jpeg",
			sizeBytes: 50,
		});
		const saved = result as { id: string; path: string };

		const err = await updateFileMessageId(saved.id, "msg-1");
		expect(err).toBeUndefined();

		const found = findFileByMessageId("msg-1");
		expect(found?.fileId).toBe(saved.id);
		expect(found?.mimeType).toBe("image/jpeg");
	});

	test("returns Error for unknown fileId", async () => {
		const err = await updateFileMessageId("missing", "msg-2");
		expect(err).toBeInstanceOf(Error);
	});
});

describe("listFiles", () => {
	test("lists all files", async () => {
		await saveFileMeta({
			path: "/a.txt",
			mimeType: "text/plain",
			sizeBytes: 1,
		});
		await saveFileMeta({
			path: "/b.txt",
			mimeType: "text/plain",
			sizeBytes: 2,
		});
		expect(listFiles()).toHaveLength(2);
	});

	test("filters by prefix", async () => {
		await saveFileMeta({
			path: "/photos/a.jpg",
			mimeType: "image/jpeg",
			sizeBytes: 1,
		});
		await saveFileMeta({
			path: "/docs/b.pdf",
			mimeType: "application/pdf",
			sizeBytes: 2,
		});
		expect(listFiles("photos")).toHaveLength(1);
	});
});

describe("deleteFile", () => {
	test("removes file from index", async () => {
		const result = await saveFileMeta({
			path: "/tmp/del.txt",
			mimeType: "text/plain",
			sizeBytes: 10,
		});
		const saved = result as { id: string };
		expect(deleteFile(saved.id)).toBe(true);
		expect(findFile(saved.id)).toBeNull();
	});

	test("returns false for unknown fileId", () => {
		expect(deleteFile("missing")).toBe(false);
	});
});

describe("rebuildFileIndex", () => {
	test("restores in-memory index from JSONL", async () => {
		const result = await saveFileMeta({
			path: "/tmp/rebuild.txt",
			mimeType: "text/plain",
			sizeBytes: 42,
		});
		const saved = result as { id: string };

		_clearFileIndexForTest();
		expect(findFile(saved.id)).toBeNull();

		await rebuildFileIndex();
		const found = findFile(saved.id);
		expect(found).not.toBeNull();
		expect(found?.sizeBytes).toBe(42);
	});
});
