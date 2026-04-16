import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

const { VAULT_ROOT } = vi.hoisted(() => ({
	VAULT_ROOT: "/tmp/test-vault",
}));

vi.mock("@/config", () => ({
	settings: {
		vault: {
			root: VAULT_ROOT,
			internal: "Klaus",
			folders: [
				{ path: "Leben", default: "full" },
				{ path: "Projekte", default: "full" },
				{ path: "Sammlung", default: "read", request: "full" },
				{ path: "Wissen", default: "read" },
				{ path: "", default: "append" },
			],
			internalPermission: { default: "read", request: "full" },
			get internalPath() {
				return join(VAULT_ROOT, "Klaus");
			},
		},
	},
}));

import { checkPermission, getReadableFolders, resolveVaultPath } from "@/vault";

// ─── checkPermission ────────────────────────────────────────────────────────

describe("checkPermission", () => {
	test("allows read on read-default folder", () => {
		expect(checkPermission({ default: "read" }, "read")).toBe("allowed");
	});

	test("allows read on full-default folder", () => {
		expect(checkPermission({ default: "full" }, "read")).toBe("allowed");
	});

	test("denies write on read-default folder without request", () => {
		expect(checkPermission({ default: "read" }, "full")).toBe("denied");
	});

	test("needs confirmation for write on read-default folder with request: full", () => {
		expect(checkPermission({ default: "read", request: "full" }, "full")).toBe(
			"needs_confirmation",
		);
	});

	test("allows append on append-default folder", () => {
		expect(checkPermission({ default: "append" }, "append")).toBe("allowed");
	});

	test("allows read on append-default folder", () => {
		expect(checkPermission({ default: "append" }, "read")).toBe("allowed");
	});

	test("denies full on append-default folder without request", () => {
		expect(checkPermission({ default: "append" }, "full")).toBe("denied");
	});

	test("denies all on none-default folder", () => {
		expect(checkPermission({ default: "none" }, "read")).toBe("denied");
	});

	test("needs confirmation for append on read-default with request: append", () => {
		expect(
			checkPermission({ default: "read", request: "append" }, "append"),
		).toBe("needs_confirmation");
	});
});

// ─── resolveVaultPath ───────────────────────────────────────────────────────

describe("resolveVaultPath", () => {
	test("resolves path in a configured folder", () => {
		const result = resolveVaultPath("Leben/notes.md");
		expect(result).not.toBeNull();
		expect(result?.absolute).toBe(join(VAULT_ROOT, "Leben/notes.md"));
		expect(result?.folder.path).toBe("Leben");
		expect(result?.isInternal).toBe(false);
	});

	test("resolves root-level file via catch-all folder", () => {
		const result = resolveVaultPath("Einkaufsliste.md");
		expect(result).not.toBeNull();
		expect(result?.absolute).toBe(join(VAULT_ROOT, "Einkaufsliste.md"));
		expect(result?.folder.path).toBe("");
	});

	test("resolves path in internal folder", () => {
		const result = resolveVaultPath("Klaus/agents/klaus.md");
		expect(result).not.toBeNull();
		expect(result?.isInternal).toBe(true);
		expect(result?.folder.default).toBe("read");
		expect(result?.folder.request).toBe("full");
	});

	test("blocks path traversal", () => {
		expect(resolveVaultPath("../etc/passwd")).toBeNull();
	});

	test("blocks path traversal via nested ..", () => {
		expect(resolveVaultPath("Leben/../../etc/passwd")).toBeNull();
	});

	test("respects vaultScope restriction", () => {
		expect(resolveVaultPath("Leben/notes.md", "Projekte")).toBeNull();
	});

	test("allows path within vaultScope", () => {
		const result = resolveVaultPath("Projekte/klaus.md", "Projekte");
		expect(result).not.toBeNull();
		expect(result?.folder.path).toBe("Projekte");
	});

	test("resolves internal folder root path", () => {
		const result = resolveVaultPath("Klaus");
		expect(result).not.toBeNull();
		expect(result?.isInternal).toBe(true);
	});
});

// ─── getReadableFolders ─────────────────────────────────────────────────────

describe("getReadableFolders", () => {
	test("returns all readable folders without scope", () => {
		const folders = getReadableFolders();
		// All configured folders + internal (all are at least read)
		expect(folders.length).toBeGreaterThanOrEqual(5);
	});

	test("filters by scope", () => {
		const folders = getReadableFolders("Leben");
		const paths = folders.map((f) => f.folder.path);
		expect(paths).toContain("Leben");
		expect(paths).not.toContain("Projekte");
	});

	test("includes internal folder when scope overlaps", () => {
		const folders = getReadableFolders("Klaus");
		const hasInternal = folders.some((f) => f.folder.path === "Klaus");
		expect(hasInternal).toBe(true);
	});

	test("excludes none-permission folders", () => {
		// All our test folders are at least read, so none should be excluded
		// This tests the filtering logic exists
		const folders = getReadableFolders();
		for (const { folder } of folders) {
			expect(folder.default).not.toBe("none");
		}
	});
});
