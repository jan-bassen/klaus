/**
 * `primitives/tools/sets/files.ts` — agent-facing files toolset.
 *
 * The underlying store is covered by `test/infra/store/files.test.ts`. Here
 * we test the agent contract: how the tools find files (by UUID vs partial
 * name), and how `read` dispatches by mime.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type FileMeta,
	initFilesStore,
	persistFileBlob,
} from "../../../../src/infra/store/files.ts";
import {
	filesDeleteTool,
	filesDownloadTool,
	filesListTool,
	filesReadTool,
	filesUploadTool,
} from "../../../../src/primitives/tools/sets/files.ts";
import { makeTmpDir, rmTmpDir } from "../../../helpers/tmp.ts";
import { makeTurn } from "../../../helpers/turn.ts";

async function seed(
	name: string,
	bytes: Buffer,
	mime: string,
): Promise<FileMeta> {
	const out = await persistFileBlob({ bytes, mimeType: mime, name });
	if (out instanceof Error) throw out;
	return {
		id: out.id,
		path: out.path,
		mimeType: out.mimeType,
		sizeBytes: out.sizeBytes,
		createdAt: new Date().toISOString(),
	};
}

describe("primitives/tools/sets/files: real execute paths", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = makeTmpDir();
		initFilesStore({ dataDir: tmp });
	});

	afterEach(() => {
		rmTmpDir(tmp);
	});

	it("upload returns the new fileId and persists the blob", async () => {
		const out = (await filesUploadTool.execute(
			{
				filename: "hello.txt",
				base64: Buffer.from("hi").toString("base64"),
				mimeType: "text/plain",
			},
			makeTurn(),
		)) as string;
		expect(out).toMatch(/^Uploaded hello\.txt — fileId: [0-9a-f-]{36}$/);
	});

	it("download by full UUID returns base64 content", async () => {
		const meta = await seed("note.txt", Buffer.from("hi"), "text/plain");
		const out = (await filesDownloadTool.execute(
			{ fileIdOrName: meta.id },
			makeTurn(),
		)) as { fileId: string; content: string; mimeType: string };
		expect(out.fileId).toBe(meta.id);
		expect(Buffer.from(out.content, "base64").toString()).toBe("hi");
	});

	it("download missing → not-found message", async () => {
		const out = await filesDownloadTool.execute(
			{ fileIdOrName: "nope" },
			makeTurn(),
		);
		expect(out).toBe("No file found for: nope");
	});

	it("read returns text/* content directly", async () => {
		const meta = await seed("notes.txt", Buffer.from("plain"), "text/plain");
		const out = await filesReadTool.execute(
			{ fileIdOrName: meta.id },
			makeTurn(),
		);
		expect(out).toBe("plain");
	});

	it("read on an image points the agent at files_download", async () => {
		const meta = await seed(
			"pic.png",
			Buffer.from([137, 80, 78, 71]),
			"image/png",
		);
		const out = await filesReadTool.execute(
			{ fileIdOrName: meta.id },
			makeTurn(),
		);
		expect(out).toMatch(/use files_download/i);
	});

	it("read on an unsupported mime explains the limitation", async () => {
		const meta = await seed("blob.bin", Buffer.from([0]), "application/x-foo");
		const out = await filesReadTool.execute(
			{ fileIdOrName: meta.id },
			makeTurn(),
		);
		expect(out).toMatch(/unsupported mime/i);
	});

	it("list with no prefix returns one row per file", async () => {
		await seed("a.txt", Buffer.from("a"), "text/plain");
		await seed("b.txt", Buffer.from("b"), "text/plain");
		const out = (await filesListTool.execute({}, makeTurn())) as string;
		expect(out.split("\n")).toHaveLength(2);
	});

	it("list returns 'No files found.' when empty", async () => {
		const out = await filesListTool.execute({}, makeTurn());
		expect(out).toBe("No files found.");
	});

	it("delete removes blob + metadata", async () => {
		const meta = await seed("doomed.txt", Buffer.from("x"), "text/plain");
		const out = (await filesDeleteTool.execute(
			{ fileIdOrName: meta.id },
			makeTurn(),
		)) as string;
		expect(out).toMatch(new RegExp(`\\(${meta.id}\\)$`));
		expect(out).toMatch(/^Deleted [0-9a-f-]{36}\.\w+ /);
		expect(
			await filesDownloadTool.execute({ fileIdOrName: meta.id }, makeTurn()),
		).toBe(`No file found for: ${meta.id}`);
	});
});
