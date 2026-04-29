/**
 * `infra/vault/index.ts` — `resolveVaultPath` + `getReadableFolders`.
 *
 * Covers the security-critical path-traversal guard, the longest-prefix
 * folder match, the internal-folder shortcut, and how agent maps prune the
 * readable folder list.
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../../../src/infra/config.ts";
import {
	getReadableFolders,
	resolveVaultPath,
} from "../../../src/infra/vault/index.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

describe("infra/vault: resolveVaultPath", () => {
	let tmp: string;
	let savedRoot: string;
	let savedInternalPath: string;
	let savedFolders: typeof settings.vault.folders;
	let savedInternalPerm: typeof settings.vault.internalPermission;

	beforeEach(() => {
		tmp = makeTmpDir();
		savedRoot = settings.vault.root;
		savedInternalPath = settings.vault.internalPath;
		savedFolders = settings.vault.folders;
		savedInternalPerm = settings.vault.internalPermission;

		settings.vault.root = tmp;
		settings.vault.internalPath = path.join(tmp, "Klaus");
		settings.vault.folders = [
			{ path: "", default: "read" },
			{ path: "Notes", default: "full" },
			{ path: "Notes/Private", default: "none" },
			{ path: "Inbox", default: "append" },
		];
		settings.vault.internalPermission = { default: "full" };
	});

	afterEach(() => {
		settings.vault.root = savedRoot;
		settings.vault.internalPath = savedInternalPath;
		settings.vault.folders = savedFolders;
		settings.vault.internalPermission = savedInternalPerm;
		rmTmpDir(tmp);
	});

	it("rejects ../ traversal that escapes the vault root", () => {
		expect(resolveVaultPath("../etc/passwd")).toBeNull();
		expect(resolveVaultPath("Notes/../../escape")).toBeNull();
	});

	it("rejects absolute paths outside the vault", () => {
		expect(resolveVaultPath("/etc/passwd")).toBeNull();
	});

	it("resolves files inside a configured folder", () => {
		const r = resolveVaultPath("Notes/today.md");
		expect(r).not.toBeNull();
		expect(r?.folder.path).toBe("Notes");
		expect(r?.absolute).toBe(path.join(tmp, "Notes/today.md"));
		expect(r?.isInternal).toBe(false);
	});

	it("longest-prefix wins (Notes/Private beats Notes)", () => {
		const r = resolveVaultPath("Notes/Private/journal.md");
		expect(r?.folder.path).toBe("Notes/Private");
	});

	it("root-level files match the empty-string catch-all folder", () => {
		const r = resolveVaultPath("scratch.md");
		expect(r?.folder.path).toBe("");
		expect(r?.isInternal).toBe(false);
	});

	it("internal Klaus/ paths return isInternal=true with internalPermission", () => {
		const r = resolveVaultPath("Klaus/agents/coach.md");
		expect(r?.isInternal).toBe(true);
		expect(r?.folder.path).toBe("Klaus");
		expect(r?.folder.default).toBe("full");
	});

	it("returns null when no folder matches and there's no root catch-all", () => {
		settings.vault.folders = [{ path: "Notes", default: "read" }];
		expect(resolveVaultPath("Inbox/thing.md")).toBeNull();
	});

	it("similar-prefix folders don't false-match (Notes vs NotesArchive)", () => {
		settings.vault.folders = [
			{ path: "Notes", default: "full" },
			{ path: "NotesArchive", default: "read" },
		];
		expect(resolveVaultPath("NotesArchive/x.md")?.folder.path).toBe(
			"NotesArchive",
		);
		expect(resolveVaultPath("Notes/x.md")?.folder.path).toBe("Notes");
	});
});

describe("infra/vault: getReadableFolders", () => {
	let tmp: string;
	let savedRoot: string;
	let savedInternalPath: string;
	let savedFolders: typeof settings.vault.folders;
	let savedInternalPerm: typeof settings.vault.internalPermission;

	beforeEach(() => {
		tmp = makeTmpDir();
		savedRoot = settings.vault.root;
		savedInternalPath = settings.vault.internalPath;
		savedFolders = settings.vault.folders;
		savedInternalPerm = settings.vault.internalPermission;

		settings.vault.root = tmp;
		settings.vault.internalPath = path.join(tmp, "Klaus");
		settings.vault.folders = [
			{ path: "Notes", default: "full" },
			{ path: "Private", default: "read" },
			{ path: "Secrets", default: "none" },
		];
		settings.vault.internalPermission = { default: "full" };
	});

	afterEach(() => {
		settings.vault.root = savedRoot;
		settings.vault.internalPath = savedInternalPath;
		settings.vault.folders = savedFolders;
		settings.vault.internalPermission = savedInternalPerm;
		rmTmpDir(tmp);
	});

	it("excludes folders with default 'none'", () => {
		const r = getReadableFolders();
		const paths = r.map((x) => x.folder.path);
		expect(paths).toContain("Notes");
		expect(paths).toContain("Private");
		expect(paths).not.toContain("Secrets");
		expect(paths).toContain("Klaus");
	});

	it("agent map can drop a folder out of readable list", () => {
		const r = getReadableFolders({ Notes: "none" });
		expect(r.map((x) => x.folder.path)).not.toContain("Notes");
	});

	it("agent map can make a folder readable", () => {
		const r = getReadableFolders({ Secrets: "read" });
		expect(r.map((x) => x.folder.path)).toContain("Secrets");
	});

	it("'*' wildcard hides everything not explicitly overridden", () => {
		const r = getReadableFolders({ "*": "none", Notes: "read" });
		expect(r.map((x) => x.folder.path)).toEqual(
			expect.arrayContaining(["Notes"]),
		);
		expect(r.map((x) => x.folder.path)).not.toContain("Private");
	});

	it("returns absolute paths anchored at the vault root", () => {
		const r = getReadableFolders();
		const notes = r.find((x) => x.folder.path === "Notes");
		expect(notes?.absolutePath).toBe(path.join(tmp, "Notes"));
	});
});
