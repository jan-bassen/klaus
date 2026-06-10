import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { type AgentVaultEntry, settings } from "../config.ts";

export type VaultOp = "read" | "append" | "full";
type VaultPermission = AgentVaultEntry | "append";
type PermissionCheck = "allowed" | "denied";

/** Per-agent path permission map. "*" is the fallback for any scoped path. */
export type AgentVaultMap = Record<string, AgentVaultEntry>;

interface ResolvedPath {
	/** Absolute filesystem path. */
	absolute: string;
	/** Vault-relative path, with "." for the vault root. */
	path: string;
}

export interface ReadableVaultRoot {
	/** Vault-relative path, with "." for the vault root. */
	path: string;
	absolutePath: string;
}

const PERM_LEVEL: Record<VaultPermission, number> = {
	none: 0,
	read: 1,
	append: 2,
	full: 3,
};

function normalizeVaultRelative(value: string): string {
	const normalized = path.normalize(value || ".");
	return normalized === "" ? "." : normalized;
}

function absoluteForVaultPath(vaultPath: string): string {
	const root = settings.vault.root;
	return vaultPath === "." ? root : path.resolve(root, vaultPath);
}

function isWithinAbsolutePath(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function isWithinVaultPath(child: string, parent: string): boolean {
	if (parent === ".") return true;
	return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function realTargetForPath(absolute: string): string | null {
	const missingParts: string[] = [];
	let existing = absolute;

	while (!existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) return null;
		missingParts.push(path.basename(existing));
		existing = parent;
	}

	try {
		const realExisting = realpathSync(existing);
		return missingParts.length === 0
			? realExisting
			: path.join(realExisting, ...missingParts.reverse());
	} catch {
		return null;
	}
}

function matchingAccessEntry(
	vaultPath: string,
	agentMap?: AgentVaultMap,
): AgentVaultEntry | undefined {
	if (!agentMap) return undefined;

	let best: { key: string; entry: AgentVaultEntry } | undefined;
	for (const [rawKey, entry] of Object.entries(agentMap)) {
		if (rawKey === "*") continue;
		const key = normalizeVaultRelative(rawKey);
		if (!isWithinVaultPath(vaultPath, key)) continue;
		if (!best || key.length > best.key.length) best = { key, entry };
	}

	return best?.entry ?? agentMap["*"];
}

/**
 * Check whether an operation is allowed on a vault-relative path.
 * Longest matching access path wins; "*" is the fallback; no match denies.
 */
export function checkPermission(
	vaultPath: string,
	op: VaultOp,
	agentMap?: AgentVaultMap,
): PermissionCheck {
	const entry = matchingAccessEntry(
		normalizeVaultRelative(vaultPath),
		agentMap,
	);
	if (!entry) return "denied";
	const needed = PERM_LEVEL[op];
	if (needed <= PERM_LEVEL[entry]) return "allowed";
	return "denied";
}

/**
 * Resolve a vault-relative path to an absolute path.
 * Returns null if the path escapes the vault root or falls outside all
 * configured global scopes.
 */
export function resolveVaultPath(relative: string): ResolvedPath | null {
	const root = settings.vault.root;
	const resolved = path.resolve(root, relative);
	const realRoot = realTargetForPath(root);
	if (!realRoot) return null;

	if (!isWithinAbsolutePath(resolved, root)) return null;

	const realResolved = realTargetForPath(resolved);
	if (!realResolved || !isWithinAbsolutePath(realResolved, realRoot))
		return null;

	const vaultPath = normalizeVaultRelative(path.relative(root, resolved));
	for (const scope of settings.vault.scopes) {
		const scopePath = normalizeVaultRelative(scope);
		const scopeAbs = absoluteForVaultPath(scopePath);
		if (isWithinAbsolutePath(resolved, scopeAbs)) {
			return { absolute: realResolved, path: vaultPath };
		}
	}

	return null;
}

/** Return scoped roots the agent can read, after applying its access map. */
export function getReadableFolders(
	agentMap?: AgentVaultMap,
): ReadableVaultRoot[] {
	const results: ReadableVaultRoot[] = [];

	function add(vaultPath: string) {
		const normalized = normalizeVaultRelative(vaultPath);
		if (results.some((entry) => entry.path === normalized)) return;
		results.push({
			path: normalized,
			absolutePath: absoluteForVaultPath(normalized),
		});
	}

	for (const rawScope of settings.vault.scopes) {
		const scope = normalizeVaultRelative(rawScope);
		if (checkPermission(scope, "read", agentMap) !== "denied") {
			add(scope);
			continue;
		}

		for (const [rawPath, permission] of Object.entries(agentMap ?? {})) {
			if (rawPath === "*" || PERM_LEVEL[permission] < PERM_LEVEL.read) {
				continue;
			}
			const vaultPath = normalizeVaultRelative(rawPath);
			const resolved = resolveVaultPath(vaultPath);
			if (resolved && isWithinVaultPath(resolved.path, scope))
				add(resolved.path);
		}
	}

	return results;
}

export function isVaultPathReadable(
	vaultPath: string,
	agentMap?: AgentVaultMap,
): boolean {
	return checkPermission(vaultPath, "read", agentMap) !== "denied";
}

/** Human-readable error for path resolution failure. */
export function accessError(): string {
	return "Invalid path — must be inside a configured vault scope.";
}

/** Human-readable error for permission denial. */
export function permissionError(vaultPath: string, op: VaultOp): string {
	const name = vaultPath === "." ? "(root)" : vaultPath;
	return `Access denied — ${op} not allowed in ${name}.`;
}
