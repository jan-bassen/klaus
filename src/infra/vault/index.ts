import path from "node:path";
import {
	type AgentVaultEntry,
	settings,
	type VaultFolder,
	type VaultPermission,
} from "@/infra/config";

export type VaultOp = "read" | "append" | "full";
type PermissionCheck = "allowed" | "needsConfirm" | "denied";

/** Per-agent override map: folder.path → permission entry. "*" matches any folder. */
export type AgentVaultMap = Record<string, AgentVaultEntry>;

interface ResolvedPath {
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

interface EffectivePermission {
	default: VaultPermission;
	confirm?: VaultPermission;
}

/**
 * The agent's vault map override (if any) replaces the folder's default
 * permission. Exact `folder.path` match wins over the `"*"` wildcard. Bare
 * string entries (`"read"`) are treated as `{default: "read"}` with no
 * elevation ceiling.
 */
function effectivePermission(
	folder: VaultFolder,
	agentMap?: AgentVaultMap,
): EffectivePermission {
	const fallback: EffectivePermission = {
		default: folder.default,
		...(folder.confirm !== undefined ? { confirm: folder.confirm } : {}),
	};
	if (!agentMap) return fallback;
	const entry = agentMap[folder.path] ?? agentMap["*"];
	if (entry === undefined) return fallback;
	if (typeof entry === "string") return { default: entry };
	return {
		default: entry.default,
		...(entry.confirm !== undefined ? { confirm: entry.confirm } : {}),
	};
}

/**
 * Check whether an operation is allowed on a folder.
 *   - `allowed`      — op level ≤ effective default
 *   - `needsConfirm` — op level > default but ≤ confirm ceiling
 *   - `denied`       — beyond ceiling, or no ceiling declared
 */
export function checkPermission(
	folder: VaultFolder,
	op: VaultOp,
	agentMap?: AgentVaultMap,
): PermissionCheck {
	const eff = effectivePermission(folder, agentMap);
	const needed = PERM_LEVEL[op];
	if (needed <= PERM_LEVEL[eff.default]) return "allowed";
	if (eff.confirm !== undefined && needed <= PERM_LEVEL[eff.confirm])
		return "needsConfirm";
	return "denied";
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
