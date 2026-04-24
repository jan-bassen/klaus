/**
 * `primitives/tools/sets/vault.ts` + `infra/vault/index.ts`
 *
 * The vault permission model is the core business rule. A regression here
 * would silently expose or withhold folders from agents.
 *
 * Split into two halves:
 *   1. Pure logic — `checkPermission`, `resolveVaultPath`, `effectivePermission`.
 *      No disk work; drive with fixture folder configs + agent maps.
 *   2. Tool execute paths — gate() → real fs ops. Use `makeTmpDir` for a fake
 *      vault and override `settings.vault.root` + `settings.vault.folders` via
 *      direct mutation (the live `settings` object is mutable).
 *
 * Setup for tools layer:
 *   - tmpDir as vault root
 *   - one "Notes" folder (default: full), one "Private" folder (default: read)
 *   - internal Klaus/ dir with `settings.vault.internalPermission = {default: read}`
 */

import { afterEach, beforeEach, describe, it } from "vitest";

// import {
//   checkPermission, resolveVaultPath,
//   type AgentVaultMap,
// } from "@/infra/vault";
// import { vaultToolset } from "@/primitives/tools/sets/vault";
// import { makeTmpDir, rmTmpDir } from "../../../helpers/tmp";
// import { makeTurn } from "../../../helpers/turn";

describe("infra/vault.checkPermission", () => {
	it.todo(
		"op <= folder.default → allowed (read on full → allowed)",
	);

	it.todo(
		"op > folder.default → denied (full on read → denied)",
	);

	it.todo(
		"agent map exact folder.path match wins over default",
	);

	it.todo(
		"agent map '*' wildcard applies when no exact match",
	);

	it.todo(
		"exact match wins over wildcard (both present)",
	);

	it.todo(
		"agentMap: 'none' denies every op",
	);
});

describe("infra/vault.resolveVaultPath", () => {
	it.todo(
		"relative path inside configured folder: returns absolute + folder",
	);

	it.todo(
		"path traversal ('../../etc/passwd'): returns null",
	);

	it.todo(
		"path inside internalPath: returns {isInternal: true, folder: internal config}",
	);

	it.todo(
		"path outside any configured folder: returns null",
	);

	it.todo(
		"longest-prefix wins when folders nest ('Notes' vs 'Notes/Private')",
	);
});

describe("vault tools: gate() + read/write/append/delete/move", () => {
	let tmpDir: string;

	beforeEach(() => {
		// tmpDir = makeTmpDir();
		// mutate settings.vault.root / folders
	});

	afterEach(() => {
		// rmTmpDir(tmpDir); restore settings
	});

	it.todo(
		"vault.write into allowed folder: file created with content",
	);

	it.todo(
		"vault.write into read-only folder: returns permission error, no file written",
	);

	it.todo(
		"vault.append: concatenates content to the end of existing file",
	);

	it.todo(
		"vault.append with heading arg: inserts under that heading (keeps surrounding text intact)",
	);

	it.todo(
		"vault.read: returns file content; missing file returns 'Note not found'",
	);

	it.todo(
		"vault.delete: removes the file; denied on read-only folder",
	);

	it.todo(
		"vault.move: src removed, dst created; denied if either side lacks permission",
	);

	it.todo(
		"vault.list: respects maxList cap and reads from readable folders only",
	);
});

describe("vault tools: agent vault override (turn.config.vault)", () => {
	it.todo(
		"agent map escalates 'read' folder to 'full' → write succeeds",
	);

	it.todo(
		"agent map downgrades 'full' folder to 'none' → read denied",
	);

	it.todo(
		"'*' wildcard agent map applies to every unnamed folder",
	);
});
