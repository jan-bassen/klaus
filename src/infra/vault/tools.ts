import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { TurnContext } from "../../pipeline/core.ts";
import { settings } from "../config.ts";
import {
	type AgentVaultMap,
	accessError,
	checkPermission,
	isVaultPathReadable,
	permissionError,
	resolveVaultPath,
	type VaultOp,
} from "./index.ts";
export const vaultRoot = (): string => settings.vault.root;

export function vaultMap(context: TurnContext): AgentVaultMap | undefined {
	return context.config?.vault as AgentVaultMap | undefined;
}

export async function gateVaultTool(
	rel: string,
	op: VaultOp,
	context: TurnContext,
): Promise<string | { error: string }> {
	const resolved = resolveVaultPath(rel);
	if (!resolved) return { error: accessError() };

	if (checkPermission(resolved.path, op, vaultMap(context)) === "denied") {
		return { error: permissionError(resolved.path, op) };
	}

	return resolved.absolute;
}

export async function walkVaultDir(
	dir: string,
	maxDepth: number,
	maxEntries: number,
	lines: string[],
	indent: number,
	agentMap?: AgentVaultMap,
): Promise<number> {
	if (indent >= maxDepth || maxEntries <= 0) return maxEntries;

	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return maxEntries;
	}

	entries.sort((a, b) => {
		if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	let remaining = maxEntries;
	for (const entry of entries) {
		if (remaining <= 0) break;
		if (entry.name.startsWith(".")) continue;

		const prefix = "  ".repeat(indent);
		const filePath = path.join(dir, entry.name);
		const vaultRel = path.relative(vaultRoot(), filePath) || ".";
		if (!isVaultPathReadable(vaultRel, agentMap)) continue;

		if (entry.isDirectory()) {
			lines.push(`${prefix}${entry.name}/`);
			remaining--;
			remaining = await walkVaultDir(
				filePath,
				maxDepth,
				remaining,
				lines,
				indent + 1,
				agentMap,
			);
		} else if (entry.name.endsWith(".md")) {
			lines.push(`${prefix}${entry.name}`);
			remaining--;
		}
	}
	return remaining;
}
