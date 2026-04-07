import {
	afterAll,
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

// ─── Store mocks (must be set up before importing files tool) ──

let tmpDir: string;

const mockSaveFileMeta = mock(
	async (): Promise<{ id: string; path: string } | Error> => ({
		id: "file-uuid-123",
		path: "/tmp/.files/2024-01-01/file-uuid-123.txt",
	}),
);

let _mockFiles: Array<{
	id: string;
	path: string;
	mimeType: string;
	sizeBytes: number;
	createdAt: string;
	messageId?: string;
}> = [];

const mockFindFile = mock((id: string) => {
	return _mockFiles.find((f) => f.id === id) ?? null;
});

const mockListFiles = mock((prefix?: string) => {
	if (!prefix) return _mockFiles;
	return _mockFiles.filter((f) => f.path.includes(prefix));
});

const mockDeleteFile = mock((id: string) => {
	const idx = _mockFiles.findIndex((f) => f.id === id);
	if (idx < 0) return false;
	_mockFiles.splice(idx, 1);
	return true;
});

mock.module("@/store/files", () => ({
	saveFileMeta: mockSaveFileMeta,
	findFile: mockFindFile,
	listFiles: mockListFiles,
	deleteFile: mockDeleteFile,
	findFileByMessageId: mock(() => null),
	updateFileMessageId: mock(async () => undefined),
	rebuildFileIndex: mock(async () => {}),
	_clearFileIndexForTest: mock(() => {}),
}));

// ─── import after mocks are registered ───────────────────────────────────────

import {
	filesDeleteTool,
	filesDownloadTool,
	filesListTool,
	filesUploadTool,
} from "@/tools/sets/files";
import type { AssembledContext, TurnContext } from "@/types";

// ─── test fixtures ────────────────────────────────────────────────────────────

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "files-test-"));
	process.env.DATA_DIR = tmpDir;
});

afterAll(async () => {
	delete process.env.DATA_DIR;
	await rm(tmpDir, { recursive: true, force: true });
});

const dummyContext = {
	chatId: "user@s.whatsapp.net",
	agent: {
		name: "test",
		modelTier: "default" as const,
		tools: [],
		toolsets: [],
		providerTools: [],
		skills: [],
		persistent: false,
		promptPath: "/dev/null",
	},
	flags: {},
	assembled: {
		vars: {},
		userVars: {},
		messageRefs: {},
		totalTokens: 0,
	} as AssembledContext,
} as TurnContext;

const TEST_FILE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeFileEntry(
	overrides: Partial<(typeof _mockFiles)[0]> = {},
): (typeof _mockFiles)[0] {
	return {
		id: TEST_FILE_ID,
		path: join(tmpDir, "file-uuid-123.txt"),
		mimeType: "text/plain",
		sizeBytes: 13,
		createdAt: new Date("2024-01-01T00:00:00Z").toISOString(),
		...overrides,
	};
}

beforeEach(() => {
	_mockFiles = [];
	mockSaveFileMeta.mockClear();
	mockSaveFileMeta.mockImplementation(async () => ({
		id: TEST_FILE_ID,
		path: join(tmpDir, "file-uuid-123.txt"),
	}));
});

// ─── filesUploadTool ─────────────────────────────────────────────────────────

describe("filesUploadTool", () => {
	test("decodes base64, writes to disk, and returns success string with fileId", async () => {
		const content = Buffer.from("hello world").toString("base64");
		const result = await filesUploadTool.execute(
			{ name: "test.txt", content, mimeType: "text/plain" },
			dummyContext,
		);
		expect(mockSaveFileMeta).toHaveBeenCalledTimes(1);
		expect(result).toContain(TEST_FILE_ID);
		expect(result).toContain("test.txt");
	});

	test('returns "Upload failed" string when saveFileMeta returns an Error', async () => {
		mockSaveFileMeta.mockImplementation(
			async () => new Error("Store write failed"),
		);
		const content = Buffer.from("data").toString("base64");
		const result = await filesUploadTool.execute(
			{ name: "fail.txt", content, mimeType: "text/plain" },
			dummyContext,
		);
		expect(result).toMatch(/Upload failed.*Store write/);
	});
});

// ─── filesDownloadTool ───────────────────────────────────────────────────────

describe("filesDownloadTool", () => {
	let testFilePath: string;

	beforeAll(async () => {
		testFilePath = join(tmpDir, "download-test.txt");
		await writeFile(testFilePath, "file contents");
	});

	test("returns base64-encoded content when file found by UUID", async () => {
		_mockFiles = [makeFileEntry({ path: testFilePath })];
		const result = await filesDownloadTool.execute(
			{ name: TEST_FILE_ID },
			dummyContext,
		);
		expect(typeof result).toBe("object");
		const r = result as { fileId: string; mimeType: string; content: string };
		expect(r.fileId).toBe(TEST_FILE_ID);
		expect(r.mimeType).toBe("text/plain");
		expect(Buffer.from(r.content, "base64").toString()).toBe("file contents");
	});

	test('returns "No file found" when store returns null', async () => {
		_mockFiles = [];
		const result = await filesDownloadTool.execute(
			{ name: "missing-uuid" },
			dummyContext,
		);
		expect(result).toContain("No file found");
	});

	test("returns error string when file cannot be read from disk", async () => {
		_mockFiles = [makeFileEntry({ path: "/nonexistent/path/file.txt" })];
		const result = await filesDownloadTool.execute(
			{ name: TEST_FILE_ID },
			dummyContext,
		);
		expect(result).toContain("Failed to read file");
	});

	test("uses path filter when input is not a UUID", async () => {
		_mockFiles = [makeFileEntry({ path: testFilePath })];
		const result = await filesDownloadTool.execute(
			{ name: "download-test" },
			dummyContext,
		);
		expect(typeof result).toBe("object");
		expect((result as { fileId: string }).fileId).toBe(TEST_FILE_ID);
	});
});

// ─── filesListTool ───────────────────────────────────────────────────────────

describe("filesListTool", () => {
	test('returns "No files found." when store returns empty', async () => {
		_mockFiles = [];
		const result = await filesListTool.execute({}, dummyContext);
		expect(result).toBe("No files found.");
	});

	test("formats each row as id | basename | mimeType | size | createdAt", async () => {
		_mockFiles = [makeFileEntry()];
		const result = (await filesListTool.execute({}, dummyContext)) as string;
		expect(result).toContain(TEST_FILE_ID);
		expect(result).toContain("text/plain");
		expect(result).toContain("13B");
	});

	test("lists multiple rows, one per line", async () => {
		_mockFiles = [makeFileEntry({ id: "aaa" }), makeFileEntry({ id: "bbb" })];
		const result = (await filesListTool.execute({}, dummyContext)) as string;
		const lines = result.split("\n");
		expect(lines).toHaveLength(2);
	});
});

// ─── filesDeleteTool ─────────────────────────────────────────────────────────

describe("filesDeleteTool", () => {
	test('returns "No file found" when store returns null', async () => {
		_mockFiles = [];
		const result = await filesDeleteTool.execute(
			{ name: "missing" },
			dummyContext,
		);
		expect(result).toContain("No file found");
	});

	test("calls deleteFile and returns success string", async () => {
		const toDelete = join(tmpDir, "to-delete.bin");
		await writeFile(toDelete, "bye");
		_mockFiles = [makeFileEntry({ path: toDelete })];

		const result = await filesDeleteTool.execute(
			{ name: TEST_FILE_ID },
			dummyContext,
		);
		expect(result).toContain("Deleted");
		expect(result).toContain(TEST_FILE_ID);
	});

	test("still deletes even when the file does not exist on disk", async () => {
		_mockFiles = [makeFileEntry({ path: "/nonexistent/ghost-file.txt" })];

		const result = await filesDeleteTool.execute(
			{ name: TEST_FILE_ID },
			dummyContext,
		);
		expect(result).toContain("Deleted");
	});
});
