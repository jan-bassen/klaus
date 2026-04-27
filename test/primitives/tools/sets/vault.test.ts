/**
 * `infra/vault/index.ts` — pure permission + path resolution logic.
 *
 * The full tool execute paths require fs + settings mutation. Here we only
 * cover the pure logic, which is the actually load-bearing part of the
 * permission model.
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings, type VaultFolder } from "@/infra/config";
import {
	type AgentVaultMap,
	checkPermission,
	resolveVaultPath,
} from "@/infra/vault";

describe("infra/vault.checkPermission", () => {
	const folder: VaultFolder = { path: "Notes", default: "read" };

	it("op <= folder.default → allowed (read on read → allowed)", () => {
		expect(checkPermission(folder, "read")).toBe("allowed");
	});

	it("op > folder.default → denied (full on read → denied)", () => {
		expect(checkPermission(folder, "full")).toBe("denied");
	});

	it("agent map exact path match wins over default", () => {
		const map: AgentVaultMap = { Notes: "full" };
		expect(checkPermission(folder, "full", map)).toBe("allowed");
	});

	it("agent map '*' wildcard applies when no exact match", () => {
		const map: AgentVaultMap = { "*": "full" };
		expect(checkPermission(folder, "full", map)).toBe("allowed");
	});

	it("exact match wins over wildcard", () => {
		const map: AgentVaultMap = { "*": "full", Notes: "none" };
		expect(checkPermission(folder, "read", map)).toBe("denied");
	});

	it("agent map 'none' denies every op", () => {
		const map: AgentVaultMap = { Notes: "none" };
		expect(checkPermission(folder, "read", map)).toBe("denied");
		expect(checkPermission(folder, "full", map)).toBe("denied");
	});
});

describe("infra/vault.resolveVaultPath", () => {
	const originalFolders = settings.vault.folders;
	const originalRoot = settings.vault.root;
	const originalInternal = settings.vault.internalPath;

	beforeEach(() => {
		// Mutate to a synthetic layout for resolution tests.
		const root = "/fake/vault";
		(settings.vault as { root: string }).root = root;
		(settings.vault as { internalPath: string }).internalPath = path.join(
			root,
			"Klaus",
		);
		(settings.vault as { folders: VaultFolder[] }).folders = [
			{ path: "Notes", default: "full" },
			{ path: "Notes/Private", default: "read" },
		];
	});

	afterEach(() => {
		(settings.vault as { folders: VaultFolder[] }).folders = originalFolders;
		(settings.vault as { root: string }).root = originalRoot;
		(settings.vault as { internalPath: string }).internalPath =
			originalInternal;
	});

	it("relative path inside configured folder: returns absolute + folder", () => {
		const r = resolveVaultPath("Notes/today.md");
		expect(r?.absolute).toBe("/fake/vault/Notes/today.md");
		expect(r?.folder.path).toBe("Notes");
		expect(r?.isInternal).toBe(false);
	});

	it("path traversal returns null", () => {
		expect(resolveVaultPath("../../etc/passwd")).toBeNull();
	});

	it("internal path resolves to internal folder + isInternal: true", () => {
		const r = resolveVaultPath("Klaus/agents/x.md");
		expect(r?.isInternal).toBe(true);
	});

	it("longest-prefix wins when folders nest", () => {
		const r = resolveVaultPath("Notes/Private/secret.md");
		expect(r?.folder.path).toBe("Notes/Private");
	});

	it("path outside configured folders returns null when no root catch-all", () => {
		expect(resolveVaultPath("Other/note.md")).toBeNull();
	});
});
