/**
 * `primitives/tools/sets/files.ts` — agent-facing files toolset.
 *
 * The underlying store is covered by `test/infra/store/files.test.ts`. Here
 * we test the agent contract: how the tools find files (by UUID vs partial
 * name), how `read` dispatches by mime, simulate-overlay coherence
 * (sim-uploaded files visible to list, not to disk readers; sim-deleted
 * files masked), and the upload simulate path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readText } from "../../../../src/infra/runtime.ts";
import { getOverlay } from "../../../../src/infra/simulation.ts";
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
				name: "hello.txt",
				content: Buffer.from("hi").toString("base64"),
				mimeType: "text/plain",
			},
			makeTurn(),
		)) as string;
		expect(out).toMatch(/^Uploaded hello\.txt — fileId: [0-9a-f-]{36}$/);
	});

	it("download by full UUID returns base64 content", async () => {
		const meta = await seed("note.txt", Buffer.from("hi"), "text/plain");
		const out = (await filesDownloadTool.execute(
			{ name: meta.id },
			makeTurn(),
		)) as { fileId: string; content: string; mimeType: string };
		expect(out.fileId).toBe(meta.id);
		expect(Buffer.from(out.content, "base64").toString()).toBe("hi");
	});

	it("download missing → not-found message", async () => {
		const out = await filesDownloadTool.execute({ name: "nope" }, makeTurn());
		expect(out).toBe("No file found for: nope");
	});

	it("read returns text/* content directly", async () => {
		const meta = await seed("notes.txt", Buffer.from("plain"), "text/plain");
		const out = await filesReadTool.execute({ name: meta.id }, makeTurn());
		expect(out).toBe("plain");
	});

	it("read on an image points the agent at files_download", async () => {
		const meta = await seed(
			"pic.png",
			Buffer.from([137, 80, 78, 71]),
			"image/png",
		);
		const out = await filesReadTool.execute({ name: meta.id }, makeTurn());
		expect(out).toMatch(/use files_download/i);
	});

	it("read on an unsupported mime explains the limitation", async () => {
		const meta = await seed("blob.bin", Buffer.from([0]), "application/x-foo");
		const out = await filesReadTool.execute({ name: meta.id }, makeTurn());
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
			{ name: meta.id },
			makeTurn(),
		)) as string;
		expect(out).toMatch(new RegExp(`\\(${meta.id}\\)$`));
		expect(out).toMatch(/^Deleted [0-9a-f-]{36}\.\w+ /);
		expect(await filesDownloadTool.execute({ name: meta.id }, makeTurn())).toBe(
			`No file found for: ${meta.id}`,
		);
	});
});

describe("primitives/tools/sets/files: simulate overlay coherence", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = makeTmpDir();
		initFilesStore({ dataDir: tmp });
	});

	afterEach(() => {
		rmTmpDir(tmp);
	});

	it("upload (sim) records into overlay without writing to disk", async () => {
		const turn = makeTurn();
		const out = (await filesUploadTool.simulate?.(
			{
				name: "simfile.txt",
				content: Buffer.from("sim").toString("base64"),
				mimeType: "text/plain",
			},
			turn,
		)) as string;
		expect(out).toMatch(/^\(sim\) Uploaded simfile\.txt/);
		expect(getOverlay(turn).uploadedFiles).toHaveLength(1);
		// No real metadata written.
		const list = await filesListTool.execute({}, makeTurn());
		expect(list).toBe("No files found.");
	});

	it("read (sim) on a sim-uploaded file is blocked (content not on disk)", async () => {
		const turn = makeTurn();
		await filesUploadTool.simulate?.(
			{
				name: "ghost.txt",
				content: Buffer.from("data").toString("base64"),
				mimeType: "text/plain",
			},
			turn,
		);
		// Look up by the UUID assigned by the simulate handler — the on-disk
		// basename uses that UUID, not the original "ghost.txt".
		const simId = getOverlay(turn).uploadedFiles[0]?.id ?? "";
		const out = await filesReadTool.simulate?.({ name: simId }, turn);
		expect(out).toMatch(/sim-uploaded this turn/);
	});

	it("read (sim) on a sim-deleted real file is masked", async () => {
		const meta = await seed("real.txt", Buffer.from("hi"), "text/plain");
		const turn = makeTurn();
		await filesDeleteTool.simulate?.({ name: meta.id }, turn);
		const out = await filesReadTool.simulate?.({ name: meta.id }, turn);
		expect(out).toMatch(/sim-deleted earlier this turn/);
		// Real file still on disk.
		expect(await readText(meta.path)).toBe("hi");
	});

	it("list (sim) merges real rows with overlay sim-uploaded entries and tags them", async () => {
		await seed("real.txt", Buffer.from("r"), "text/plain");
		const turn = makeTurn();
		await filesUploadTool.simulate?.(
			{
				name: "sim.txt",
				content: Buffer.from("s").toString("base64"),
				mimeType: "text/plain",
			},
			turn,
		);
		const out = (await filesListTool.simulate?.({}, turn)) as string;
		const lines = out.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines.some((l) => l.includes("(sim)"))).toBe(true);
	});
});
