import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readText } from "../../../src/infra/runtime.ts";
import {
	deleteFile,
	findFile,
	findFileByExternalId,
	findFileByMessageId,
	initFilesStore,
	listFiles,
	persistFileBlob,
	rebuildFileIndex,
	updateFileMessageId,
} from "../../../src/infra/store/files.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

describe("infra/store/files: persistFileBlob", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initFilesStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("returns id/path/mimeType/sizeBytes and is findable", async () => {
		const bytes = Buffer.from("hello");
		const result = await persistFileBlob({ bytes, mimeType: "text/plain" });
		expect(result).not.toBeInstanceOf(Error);
		if (result instanceof Error) return;

		expect(result.metadataSaved).toBe(true);
		expect(result.mimeType).toBe("text/plain");
		expect(result.sizeBytes).toBe(5);

		const found = findFile(result.id);
		expect(found).not.toBeNull();
		expect(found?.id).toBe(result.id);
		expect(found?.mimeType).toBe("text/plain");
	});

	it("uses name extension when provided", async () => {
		const result = await persistFileBlob({
			bytes: Buffer.from("data"),
			mimeType: "image/jpeg",
			name: "photo.jpg",
		});
		expect(result).not.toBeInstanceOf(Error);
		if (result instanceof Error) return;
		expect(result.path.endsWith(".jpg")).toBe(true);
	});

	it("derives extension from mimeType when name is absent", async () => {
		const result = await persistFileBlob({
			bytes: Buffer.from("audio"),
			mimeType: "audio/ogg",
		});
		expect(result).not.toBeInstanceOf(Error);
		if (result instanceof Error) return;
		expect(result.path.endsWith(".ogg")).toBe(true);
	});

	it("explicit extension overrides mimeType-derived one", async () => {
		const result = await persistFileBlob({
			bytes: Buffer.from("data"),
			mimeType: "application/octet-stream",
			extension: "bin",
		});
		expect(result).not.toBeInstanceOf(Error);
		if (result instanceof Error) return;
		expect(result.path.endsWith(".bin")).toBe(true);
	});
});

describe("infra/store/files: index lookups", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initFilesStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("findFileByMessageId resolves after saving with messageId", async () => {
		const result = await persistFileBlob({
			bytes: Buffer.from("audio"),
			mimeType: "audio/ogg",
			messageId: "msg-1",
		});
		expect(result).not.toBeInstanceOf(Error);
		if (result instanceof Error) return;

		const byMsg = findFileByMessageId("msg-1");
		expect(byMsg).not.toBeNull();
		expect(byMsg?.fileId).toBe(result.id);
		expect(byMsg?.mimeType).toBe("audio/ogg");
	});

	it("findFileByMessageId returns null for unknown messageId", () => {
		expect(findFileByMessageId("no-such-msg")).toBeNull();
	});

	it("findFileByExternalId resolves after saving with externalId", async () => {
		const result = await persistFileBlob({
			bytes: Buffer.from("data"),
			mimeType: "image/png",
			externalId: "ext-abc",
		});
		expect(result).not.toBeInstanceOf(Error);
		if (result instanceof Error) return;

		const byExt = findFileByExternalId("ext-abc");
		expect(byExt).not.toBeNull();
		expect(byExt?.fileId).toBe(result.id);
	});

	it("findFileByExternalId returns null for unknown externalId", () => {
		expect(findFileByExternalId("no-such-ext")).toBeNull();
	});

	it("updateFileMessageId backfills messageId index", async () => {
		const result = await persistFileBlob({
			bytes: Buffer.from("data"),
			mimeType: "image/png",
		});
		expect(result).not.toBeInstanceOf(Error);
		if (result instanceof Error) return;

		expect(findFileByMessageId("msg-late")).toBeNull();
		const err = await updateFileMessageId(result.id, "msg-late");
		expect(err).toBeUndefined();
		const byMsg = findFileByMessageId("msg-late");
		expect(byMsg?.fileId).toBe(result.id);
	});

	it("updateFileMessageId returns Error for unknown fileId", async () => {
		const err = await updateFileMessageId("no-such-id", "msg");
		expect(err).toBeInstanceOf(Error);
	});
});

describe("infra/store/files: listFiles + deleteFile", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initFilesStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("listFiles returns all saved files", async () => {
		await persistFileBlob({ bytes: Buffer.from("a"), mimeType: "text/plain" });
		await persistFileBlob({ bytes: Buffer.from("b"), mimeType: "text/plain" });
		expect(listFiles()).toHaveLength(2);
	});

	it("listFiles with prefix filters by path prefix", async () => {
		await persistFileBlob({ bytes: Buffer.from("a"), mimeType: "text/plain" });
		const all = listFiles(tmpDir);
		expect(all).toHaveLength(1);
		const none = listFiles("/nonexistent/path/");
		expect(none).toHaveLength(0);
	});

	it("deleteFile removes from all three indexes; second delete returns false", async () => {
		const result = await persistFileBlob({
			bytes: Buffer.from("data"),
			mimeType: "image/png",
			messageId: "msg-del",
			externalId: "ext-del",
		});
		expect(result).not.toBeInstanceOf(Error);
		if (result instanceof Error) return;

		expect(await deleteFile(result.id)).toBe(true);
		expect(findFile(result.id)).toBeNull();
		expect(findFileByMessageId("msg-del")).toBeNull();
		expect(findFileByExternalId("ext-del")).toBeNull();
		expect(await deleteFile(result.id)).toBe(false);
	});
});

describe("infra/store/files: rebuildFileIndex", () => {
	it("reconstructs in-memory indexes from JSONL after restart", async () => {
		const tmpDir = makeTmpDir();
		try {
			initFilesStore({ dataDir: tmpDir });
			const result = await persistFileBlob({
				bytes: Buffer.from("persist"),
				mimeType: "text/plain",
				messageId: "msg-rebuild",
				externalId: "ext-rebuild",
			});
			expect(result).not.toBeInstanceOf(Error);
			if (result instanceof Error) return;
			const savedId = result.id;

			// Fresh store — in-memory index is gone.
			initFilesStore({ dataDir: tmpDir });
			expect(findFile(savedId)).toBeNull();

			await rebuildFileIndex();

			const found = findFile(savedId);
			expect(found?.id).toBe(savedId);
			expect(findFileByMessageId("msg-rebuild")?.fileId).toBe(savedId);
			expect(findFileByExternalId("ext-rebuild")?.fileId).toBe(savedId);
		} finally {
			rmTmpDir(tmpDir);
		}
	});

	it("update records in JSONL are applied last-write-wins on rebuild", async () => {
		const tmpDir = makeTmpDir();
		try {
			initFilesStore({ dataDir: tmpDir });
			const result = await persistFileBlob({
				bytes: Buffer.from("data"),
				mimeType: "text/plain",
			});
			expect(result).not.toBeInstanceOf(Error);
			if (result instanceof Error) return;

			await updateFileMessageId(result.id, "msg-backfill");

			initFilesStore({ dataDir: tmpDir });
			await rebuildFileIndex();
			expect(findFileByMessageId("msg-backfill")?.fileId).toBe(result.id);
		} finally {
			rmTmpDir(tmpDir);
		}
	});

	it("update records rewrite the JSONL index compactly", async () => {
		const tmpDir = makeTmpDir();
		try {
			initFilesStore({ dataDir: tmpDir });
			const result = await persistFileBlob({
				bytes: Buffer.from("data"),
				mimeType: "text/plain",
			});
			expect(result).not.toBeInstanceOf(Error);
			if (result instanceof Error) return;

			await updateFileMessageId(result.id, "msg-backfill");
			const text = await readText(
				path.join(tmpDir, "files", "files-index.jsonl"),
			);
			const lines = text.split("\n").filter((line) => line.trim());
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
				id: result.id,
				messageId: "msg-backfill",
			});
		} finally {
			rmTmpDir(tmpDir);
		}
	});

	it("deleted metadata stays deleted after rebuild", async () => {
		const tmpDir = makeTmpDir();
		try {
			initFilesStore({ dataDir: tmpDir });
			const result = await persistFileBlob({
				bytes: Buffer.from("data"),
				mimeType: "text/plain",
				messageId: "msg-delete",
			});
			expect(result).not.toBeInstanceOf(Error);
			if (result instanceof Error) return;

			expect(await deleteFile(result.id)).toBe(true);

			initFilesStore({ dataDir: tmpDir });
			await rebuildFileIndex();
			expect(findFile(result.id)).toBeNull();
			expect(findFileByMessageId("msg-delete")).toBeNull();
		} finally {
			rmTmpDir(tmpDir);
		}
	});
});
