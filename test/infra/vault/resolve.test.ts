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
	let savedScopes: typeof settings.vault.scopes;

	beforeEach(() => {
		tmp = makeTmpDir();
		savedRoot = settings.vault.root;
		savedScopes = settings.vault.scopes;

		settings.vault.root = tmp;
		settings.vault.scopes = ["."];
	});

	afterEach(() => {
		settings.vault.root = savedRoot;
		settings.vault.scopes = savedScopes;
		rmTmpDir(tmp);
	});

	it("rejects traversal that escapes the vault root", () => {
		expect(resolveVaultPath("../etc/passwd")).toBeNull();
		expect(resolveVaultPath("Notes/../../escape")).toBeNull();
	});

	it("rejects absolute paths outside the vault", () => {
		expect(resolveVaultPath("/etc/passwd")).toBeNull();
	});

	it("'.' scope resolves root files and nested files", () => {
		expect(resolveVaultPath("scratch.md")).toMatchObject({
			absolute: path.join(tmp, "scratch.md"),
			path: "scratch.md",
		});
		expect(resolveVaultPath("Notes/today.md")).toMatchObject({
			absolute: path.join(tmp, "Notes/today.md"),
			path: path.join("Notes", "today.md"),
		});
	});

	it("specific scopes allow only their subtree", () => {
		settings.vault.scopes = ["Notes"];

		expect(resolveVaultPath("Notes/today.md")?.path).toBe(
			path.join("Notes", "today.md"),
		);
		expect(resolveVaultPath("Inbox/thing.md")).toBeNull();
	});

	it("Klaus paths are normal vault paths when covered by scope", () => {
		const r = resolveVaultPath("Klaus/agents/coach.md");
		expect(r).toMatchObject({
			absolute: path.join(tmp, "Klaus/agents/coach.md"),
			path: path.join("Klaus", "agents", "coach.md"),
		});
	});

	it("similar-prefix scopes do not false-match", () => {
		settings.vault.scopes = ["Notes", "NotesArchive"];

		expect(resolveVaultPath("NotesArchive/x.md")?.path).toBe(
			path.join("NotesArchive", "x.md"),
		);
		expect(resolveVaultPath("Notes/x.md")?.path).toBe(
			path.join("Notes", "x.md"),
		);
		expect(resolveVaultPath("Notebook/x.md")).toBeNull();
	});
});

describe("infra/vault: getReadableFolders", () => {
	let tmp: string;
	let savedRoot: string;
	let savedScopes: typeof settings.vault.scopes;

	beforeEach(() => {
		tmp = makeTmpDir();
		savedRoot = settings.vault.root;
		savedScopes = settings.vault.scopes;

		settings.vault.root = tmp;
		settings.vault.scopes = ["."];
	});

	afterEach(() => {
		settings.vault.root = savedRoot;
		settings.vault.scopes = savedScopes;
		rmTmpDir(tmp);
	});

	it("returns scoped roots allowed by the access map", () => {
		const r = getReadableFolders({ "*": "read", Klaus: "none" });
		expect(r).toEqual([{ path: ".", absolutePath: tmp }]);
	});

	it("can expose an explicitly allowed subpath under an unreadable scope", () => {
		const r = getReadableFolders({ "*": "none", Klaus: "full" });
		expect(r).toEqual([
			{ path: "Klaus", absolutePath: path.join(tmp, "Klaus") },
		]);
	});

	it("cannot expose access paths outside vault scopes", () => {
		settings.vault.scopes = ["Notes"];
		const r = getReadableFolders({ "*": "none", Klaus: "full" });
		expect(r).toEqual([]);
	});

	it("ignores explicit access paths that escape the vault", () => {
		const r = getReadableFolders({ "*": "none", "../outside": "full" });
		expect(r).toEqual([]);
	});

	it("returns absolute paths anchored at the vault root", () => {
		settings.vault.scopes = ["Notes"];
		const r = getReadableFolders({ "*": "read" });
		expect(r).toEqual([
			{ path: "Notes", absolutePath: path.join(tmp, "Notes") },
		]);
	});
});
