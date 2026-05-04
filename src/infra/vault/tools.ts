import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { TurnContext } from "../../pipeline/core.ts";
import { settings } from "../config.ts";
import { readText } from "../runtime.ts";
import type { SimulationOverlay } from "../simulation.ts";
import {
	type AgentVaultMap,
	accessError,
	checkPermission,
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

	if (checkPermission(resolved.folder, op, vaultMap(context)) === "denied") {
		return { error: permissionError(resolved.folder.path, op) };
	}

	return resolved.absolute;
}

export async function readSimulatedVaultContent(
	absPath: string,
	overlay: SimulationOverlay,
): Promise<string | null> {
	if (overlay.vaultDeletes.has(absPath)) return null;
	const pending = overlay.vaultWrites.get(absPath);
	if (pending !== undefined) return pending;
	try {
		return await readText(absPath);
	} catch {
		return null;
	}
}

export async function walkVaultDir(
	dir: string,
	maxDepth: number,
	maxEntries: number,
	lines: string[],
	indent: number,
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
		if (entry.isDirectory()) {
			lines.push(`${prefix}${entry.name}/`);
			remaining--;
			remaining = await walkVaultDir(
				path.join(dir, entry.name),
				maxDepth,
				remaining,
				lines,
				indent + 1,
			);
		} else if (entry.name.endsWith(".md")) {
			lines.push(`${prefix}${entry.name}`);
			remaining--;
		}
	}
	return remaining;
}
