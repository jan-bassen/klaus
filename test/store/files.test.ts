import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import {
	deleteFile,
	findFile,
	findFileByExternalId,
	findFileByMessageId,
	listFiles,
	rebuildFileIndex,
	saveFileMeta,
	updateFileMessageId,
} from "@/store/files";
import { installTestServices } from "../helpers/services";

let tmpDir: string;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "files-test-"));
});

afterAll(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
	installTestServices({ dataDir: tmpDir });
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
		expect(listFiles("/photos")).toHaveLength(1);
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

describe("saveFileMeta with externalId", () => {
	test("stores externalId and makes it findable via findFileByExternalId", async () => {
		const result = await saveFileMeta({
			path: "/tmp/photo.jpg",
			mimeType: "image/jpeg",
			sizeBytes: 200,
			externalId: "wa-ext-1",
		});
		expect(result).not.toBeInstanceOf(Error);
		const saved = result as { id: string; path: string };

		const found = findFileByExternalId("wa-ext-1");
		expect(found).not.toBeNull();
		expect(found?.fileId).toBe(saved.id);
		expect(found?.mimeType).toBe("image/jpeg");
	});

	test("findFileByExternalId returns non-image files (e.g. PDFs)", async () => {
		const saved = (await saveFileMeta({
			path: "/tmp/doc.pdf",
			mimeType: "application/pdf",
			sizeBytes: 100,
			externalId: "wa-ext-pdf",
		})) as { id: string };
		const found = findFileByExternalId("wa-ext-pdf");
		expect(found).not.toBeNull();
		expect(found?.fileId).toBe(saved.id);
		expect(found?.mimeType).toBe("application/pdf");
	});

	test("findFileByExternalId returns null for unknown externalId", () => {
		expect(findFileByExternalId("unknown-ext")).toBeNull();
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

		// Fresh services: in-memory index starts empty, rebuild should repopulate.
		installTestServices({ dataDir: tmpDir });
		expect(findFile(saved.id)).toBeNull();

		await rebuildFileIndex();
		const found = findFile(saved.id);
		expect(found).not.toBeNull();
		expect(found?.sizeBytes).toBe(42);
	});

	test("restores externalFileIndex from JSONL", async () => {
		const result = await saveFileMeta({
			path: "/tmp/rebuild.jpg",
			mimeType: "image/jpeg",
			sizeBytes: 300,
			externalId: "wa-rebuild-ext",
		});
		const saved = result as { id: string };

		installTestServices({ dataDir: tmpDir });
		expect(findFileByExternalId("wa-rebuild-ext")).toBeNull();

		await rebuildFileIndex();
		const found = findFileByExternalId("wa-rebuild-ext");
		expect(found).not.toBeNull();
		expect(found?.fileId).toBe(saved.id);
	});
});
