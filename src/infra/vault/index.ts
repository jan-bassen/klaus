import path from "node:path";
import {
	settings,
	type VaultFolder,
	type VaultPermission,
} from "@/infra/config";

export type VaultOp = "read" | "append" | "full";
export type PermissionCheck = "allowed" | "denied";

/** Per-agent override map: folder.path → permission. "*" matches any folder. */
export type AgentVaultMap = Record<string, "none" | "read" | "full">;

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

/**
 * The agent's vault map override (if any) replaces the folder's default
 * permission. Exact `folder.path` match wins over the `"*"` wildcard.
 */
function effectivePermission(
	folder: VaultFolder,
	agentMap?: AgentVaultMap,
): VaultPermission {
	if (!agentMap) return folder.default;
	const exact = agentMap[folder.path];
	if (exact !== undefined) return exact;
	const wildcard = agentMap["*"];
	if (wildcard !== undefined) return wildcard;
	return folder.default;
}

/** Check whether an operation is allowed on a folder. */
export function checkPermission(
	folder: VaultFolder,
	op: VaultOp,
	agentMap?: AgentVaultMap,
): PermissionCheck {
	const eff = effectivePermission(folder, agentMap);
	const needed = PERM_LEVEL[op];
	return needed <= PERM_LEVEL[eff] ? "allowed" : "denied";
}

/**
 * Resolve a vault-relative path to its owning folder + absolute path.
 * Returns null if the path escapes the vault root or falls outside any
 * configured folder.
 */
export function resolveVaultPath(relative: string): ResolvedPath | null {
	const root = settings.vault.root;
	const resolved = path.resolve(root, relative);

	// Path traversal guard
	if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;

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

/** Return all folders the agent can read, after applying the agent vault map. */
export function getReadableFolders(
	agentMap?: AgentVaultMap,
): Array<{ folder: VaultFolder; absolutePath: string }> {
	const root = settings.vault.root;
	const results: Array<{ folder: VaultFolder; absolutePath: string }> = [];

	const internalFolder: VaultFolder = {
		path: settings.vault.internal,
		...settings.vault.internalPermission,
	};
	if (checkPermission(internalFolder, "read", agentMap) !== "denied") {
		results.push({
			folder: internalFolder,
			absolutePath: settings.vault.internalPath,
		});
	}

	for (const folder of settings.vault.folders) {
		if (checkPermission(folder, "read", agentMap) === "denied") continue;
		const abs = folder.path === "" ? root : path.resolve(root, folder.path);
		results.push({ folder, absolutePath: abs });
	}

	return results;
}

/** Human-readable error for path resolution failure. */
export function accessError(): string {
	return "Invalid path — must be inside a configured vault folder.";
}

/** Human-readable error for permission denial. */
export function permissionError(folderPath: string, op: VaultOp): string {
	const name = folderPath || "(root)";
	return `Access denied — ${op} not allowed in ${name}.`;
}
