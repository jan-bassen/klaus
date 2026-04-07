import path from "node:path";
import { settings, type VaultFolder, type VaultPermission } from "@/settings";

export type VaultOp = "read" | "append" | "full";
export type PermissionCheck = "allowed" | "needs_confirmation" | "denied";

export interface ResolvedPath {
	/** Absolute filesystem path. */
	absolute: string;
	/** The folder config this path belongs to. */
	folder: VaultFolder;
	/** Whether this path is inside the internal folder (Klaus/). */
	isInternal: boolean;
}

const PERM_LEVEL: Record<VaultPermission, number> = {
	none: 0,
	read: 1,
	append: 2,
	full: 3,
};

/** Check whether an operation is allowed on a folder. */
export function checkPermission(
	folder: Pick<VaultFolder, "default" | "request">,
	op: VaultOp,
): PermissionCheck {
	const needed = PERM_LEVEL[op];
	if (needed <= PERM_LEVEL[folder.default]) return "allowed";
	if (folder.request && needed <= PERM_LEVEL[folder.request])
		return "needs_confirmation";
	return "denied";
}

/**
 * Resolve a vault-relative path to its owning folder + absolute path.
 * Returns null if the path escapes the vault root, falls outside any configured
 * folder, or violates the agent's vaultScope restriction.
 */
export function resolveVaultPath(
	relative: string,
	scope?: string,
): ResolvedPath | null {
	const root = settings.vault.root;
	const resolved = path.resolve(root, relative);

	// Path traversal guard
	if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;

	// Scope restriction — agent can only access paths within its scope
	if (scope) {
		const scopeDir = path.resolve(root, scope);
		if (resolved !== scopeDir && !resolved.startsWith(scopeDir + path.sep))
			return null;
	}

	// Check if path falls under the internal directory
	const internalPath = settings.vault.internalPath;
	if (
		resolved === internalPath ||
		resolved.startsWith(internalPath + path.sep)
	) {
		return {
			absolute: resolved,
			folder: {
				path: settings.vault.internal,
				...settings.vault.internalPermission,
			},
			isInternal: true,
		};
	}

	// Match against configured folders (longest prefix first)
	const sorted = [...settings.vault.folders].sort(
		(a, b) => b.path.length - a.path.length,
	);

	for (const folder of sorted) {
		if (folder.path === "") {
			// Root-level catch-all: only matches files directly in root or
			// paths not claimed by any other folder
			return { absolute: resolved, folder, isInternal: false };
		}

		const folderAbs = path.resolve(root, folder.path);
		if (resolved === folderAbs || resolved.startsWith(folderAbs + path.sep)) {
			return { absolute: resolved, folder, isInternal: false };
		}
	}

	// No matching folder — path is outside configured areas
	return null;
}

/** Return all folders the agent can read, respecting an optional scope. */
export function getReadableFolders(
	scope?: string,
): Array<{ folder: VaultFolder; absolutePath: string }> {
	const root = settings.vault.root;
	const results: Array<{ folder: VaultFolder; absolutePath: string }> = [];

	// Internal folder
	const internalFolder: VaultFolder = {
		path: settings.vault.internal,
		...settings.vault.internalPermission,
	};
	if (checkPermission(internalFolder, "read") !== "denied") {
		const abs = settings.vault.internalPath;
		if (!scope || abs.startsWith(path.resolve(root, scope))) {
			results.push({ folder: internalFolder, absolutePath: abs });
		}
	}

	// Configured folders
	for (const folder of settings.vault.folders) {
		if (checkPermission(folder, "read") === "denied") continue;

		const abs = folder.path === "" ? root : path.resolve(root, folder.path);

		if (scope) {
			const scopeAbs = path.resolve(root, scope);
			// Include folder if it overlaps with scope
			if (
				abs !== scopeAbs &&
				!abs.startsWith(scopeAbs + path.sep) &&
				!scopeAbs.startsWith(abs + path.sep)
			)
				continue;
		}

		results.push({ folder, absolutePath: abs });
	}

	return results;
}

/** Human-readable error for scope/permission violations. */
export function accessError(scope?: string): string {
	return scope
		? `Access denied — path must be inside vault scope: ${scope}`
		: "Invalid path — must be inside a configured vault folder.";
}

/** Human-readable error for permission denial. */
export function permissionError(folderPath: string, op: VaultOp): string {
	const name = folderPath || "(root)";
	return `Access denied — ${op} not allowed in ${name}.`;
}
