/**
 * `infra/simulation.ts` + end-to-end read-from-write coherence through the
 * real tool wrappers (vault, dispatch, files).
 *
 * For the end-to-end tests, invoke tools via their `execute` and `simulate`
 * directly (or via `assembleTools(def, turn).allTools[name].execute(args)` to
 * exercise the `invokeTool` dispatcher).
 *
 * Disk-untouched assertions are critical — use `fs.readdirSync` after sim
 * flows to confirm zero files were created outside the tmp data/vault dirs.
 */

import { afterEach, beforeEach, describe, it } from "vitest";

// import { getOverlay, fakeExternal, fakeStateful } from "@/infra/simulation";
// import { makeTurn } from "../helpers/turn";
// import { makeTmpDir, rmTmpDir } from "../helpers/tmp";
// import { initAllStores } from "../helpers/stores";

describe("infra/simulation: overlay isolation", () => {
	it.todo(
		"different TurnContext objects get different overlays (WeakMap identity)",
	);

	it.todo("repeated getOverlay(sameTurn) returns the same overlay instance");
});

describe("infra/simulation: fakers", () => {
	it.todo(
		"fakeExternal('reply', {content:'hi'}) returns {result:'sent', intent} with a quoted preview of the content",
	);

	it.todo(
		"fakeExternal('react', {emoji:'👍'}) returns {result:'reacted', intent}",
	);

	it.todo("fakeStateful summarises the first arg into intent (name=value…)");
});

describe("infra/simulation: vault overlay read-from-write", () => {
	let tmpDir: string;

	beforeEach(() => {
		// tmpDir = makeTmpDir();
		// initAllStores(tmpDir);
		// override settings.vault.root/folders to point at tmpDir
	});

	afterEach(() => {
		// rmTmpDir(tmpDir);
	});

	it.todo("vault_write(sim) + vault_read(sim) → returns pending content");

	it.todo(
		"real vault_read of the same path returns 'Note not found' (disk untouched)",
	);

	it.todo("vault_append(sim) on overlay-written note concatenates correctly");

	it.todo("vault_append(sim) with a heading inserts under that heading");

	it.todo("vault_delete(sim) + vault_read(sim) → 'Note not found'");

	it.todo("vault_move(sim) copies content to new path and tombstones old");

	it.todo(
		"vault_list(sim) annotates [sim +N: …] and [sim -N: …] for in-scope changes",
	);

	it.todo(
		"vault_search(sim) returns overlay hits tagged '(sim)' alongside real hits",
	);
});

describe("infra/simulation: dispatch overlay", () => {
	it.todo(
		"dispatch.timer(sim) adds to overlay.pendingTimers; listTimers() unchanged",
	);

	it.todo("dispatch_schedule(sim) adds to overlay.pendingSchedules");

	it.todo("dispatch_list(sim) merges real + pending and tags sim entries");

	it.todo(
		"dispatch_cancel(sim) on a sim-only timer removes it from pendingTimers",
	);

	it.todo(
		"dispatch_cancel(sim) on a real timer ID adds to cancelledIds (real untouched)",
	);
});

describe("infra/simulation: files overlay", () => {
	it.todo(
		"files_upload(sim) creates a virtual FileMeta; listFiles() unchanged",
	);

	it.todo("files_list(sim) merges real + sim and filters deletes");

	it.todo("files_delete(sim) of a sim-upload removes it outright");

	it.todo(
		"files_delete(sim) of a real fileId adds to deletedFileIds (disk untouched)",
	);

	it.todo(
		"files_read(sim) / files_download(sim) flag sim-uploads as 'content not materialized'",
	);
});

describe("infra/simulation: no-side-effect guarantee", () => {
	it.todo(
		"full write/delete/upload/timer chain under sim leaves conversations/, files/, timers.json, schedules.json unchanged",
	);

	it.todo(
		"top-level sim run does NOT enqueue any real WhatsApp message via pendingSubReplies flush",
	);
});
