import type { Dirent } from "node:fs";
import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { settings } from "@/infra/config";
import { getOverlay, type SimulationOverlay } from "@/infra/simulation";
import {
	type AgentVaultMap,
	accessError,
	checkPermission,
	getReadableFolders,
	permissionError,
	resolveVaultPath,
	type VaultOp,
} from "@/infra/vault";
import type { TurnContext } from "@/pipeline/agent";
import type { ToolDefinition, ToolsetDefinition } from "@/primitives/tools";

const vaultRoot = () => settings.vault.root;

function vaultMap(context: TurnContext): AgentVaultMap | undefined {
	return context.config?.vault as AgentVaultMap | undefined;
}

/**
 * Gate a vault operation: resolve path + check permission.
 * Returns the absolute path on success, or a user-facing error string on failure.
 */
async function gate(
	rel: string,
	op: VaultOp,
	context: TurnContext,
): Promise<string | { error: string }> {
	const resolved = resolveVaultPath(rel);
	if (!resolved) return { error: accessError() };

	// `needsConfirm` is treated as proceed here — the framework's confirmation
	// gate (in `pipeline/confirmations.ts`) is the actual enforcement point.
	// Reaching execute means the user already approved (or the call was
	// non-gated for reasons like sim/autoAccept). This branch only blocks
	// outright denials.
	if (checkPermission(resolved.folder, op, vaultMap(context)) === "denied")
		return { error: permissionError(resolved.folder.path, op) };

	return resolved.absolute;
}

/**
 * `requiresConfirmation` builder shared by all write-class vault tools. Asks
 * for confirmation iff the path resolves into a folder whose effective
 * permission for `op` comes back as `needsConfirm`. Resolution failures
 * (escapes, unmapped paths) and outright denials skip the gate — `execute`'s
 * own `gate()` call surfaces them as user-facing errors.
 */
function vaultConfirm(verb: string, op: VaultOp) {
	return (
		input: { path: string },
		context: TurnContext,
	): false | { verb: string; summary: string } => {
		const resolved = resolveVaultPath(input.path);
		if (!resolved) return false;
		if (
			checkPermission(resolved.folder, op, vaultMap(context)) === "needsConfirm"
		) {
			return { verb, summary: input.path };
		}
		return false;
	};
}

/**
 * Read `absPath`'s content as the sim sees it:
 *   - `null` if it's been deleted in the overlay
 *   - overlay-pending content if there's a queued write
 *   - else the real file on disk (or `null` if missing)
 */
async function simReadContent(
	absPath: string,
	overlay: SimulationOverlay,
): Promise<string | null> {
	if (overlay.vaultDeletes.has(absPath)) return null;
	const pending = overlay.vaultWrites.get(absPath);
	if (pending !== undefined) return pending;
	try {
		return await Bun.file(absPath).text();
	} catch {
		return null;
	}
}

// ─── read ────────────────────────────────────────────────────────────────────

const vaultReadSchema = z.object({
	path: z
		.string()
		.describe('Relative path to the note, e.g. "Projects/Klaus.md"'),
});

export const vaultReadTool: ToolDefinition<typeof vaultReadSchema> = {
	name: "vault_read",
	description:
		"Read a note from the vault by its relative path. Returns the full markdown content including frontmatter.",
	inputSchema: vaultReadSchema,
	execute: async ({ path: rel }, context) => {
		const result = await gate(rel, "read", context);
		if (typeof result === "object") return result.error;

		try {
			return await Bun.file(result).text();
		} catch {
			return `Note not found: ${rel}`;
		}
	},
	simulate: async ({ path: rel }, context) => {
		const gated = await gate(rel, "read", context);
		if (typeof gated === "object") return gated.error;
		const content = await simReadContent(gated, getOverlay(context));
		return content ?? `Note not found: ${rel}`;
	},
	sideEffect: "pure",
	kind: "builtin",
	capability: "resource",
};

// ─── search ──────────────────────────────────────────────────────────────────

const vaultSearchSchema = z.object({
	query: z
		.string()
		.describe(
			"Search terms (case-insensitive substring match across all notes)",
		),
	limit: z.number().optional().default(10).describe("Max results to return"),
});

export const vaultSearchTool: ToolDefinition<typeof vaultSearchSchema> = {
	name: "vault_search",
	description:
		"Full-text search across all markdown notes in the vault. Returns matching file paths with context lines.",
	inputSchema: vaultSearchSchema,
	execute: async ({ query, limit }, context) => {
		const glob = new Bun.Glob("**/*.md");
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (terms.length === 0) return "Empty query.";

		const readable = getReadableFolders(vaultMap(context));
		const results: string[] = [];

		for (const { absolutePath } of readable) {
			if (results.length >= limit) break;

			for await (const file of glob.scan({ cwd: absolutePath })) {
				if (results.length >= limit) break;

				try {
					const text = await Bun.file(path.join(absolutePath, file)).text();
					const lower = text.toLowerCase();
					if (terms.every((t) => lower.includes(t))) {
						const lines = text.split("\n");
						const matchLine = lines.find((l) => {
							const ll = l.toLowerCase();
							return terms.some((t) => ll.includes(t));
						});
						const preview = matchLine?.trim().slice(0, 120) ?? "";
						// Return vault-relative path
						const vaultRel = path.relative(
							vaultRoot(),
							path.join(absolutePath, file),
						);
						results.push(`${vaultRel}${preview ? ` — ${preview}` : ""}`);
					}
				} catch {
					// Skip unreadable files
				}
			}
		}

		return results.length > 0
			? results.join("\n")
			: `No notes matching "${query}".`;
	},
	simulate: async (input, context) => {
		const base = await vaultSearchTool.execute(input, context);
		if (typeof base !== "string") return base;
		const overlay = getOverlay(context);
		if (overlay.vaultWrites.size === 0 && overlay.vaultDeletes.size === 0) {
			return base;
		}
		const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
		if (terms.length === 0) return base;

		const root = vaultRoot();
		const deletedRels = new Set(
			[...overlay.vaultDeletes].map((abs) => path.relative(root, abs)),
		);
		const simHits: string[] = [];
		for (const [abs, content] of overlay.vaultWrites) {
			const lower = content.toLowerCase();
			if (!terms.every((t) => lower.includes(t))) continue;
			const matchLine = content.split("\n").find((l) => {
				const ll = l.toLowerCase();
				return terms.some((t) => ll.includes(t));
			});
			const preview = matchLine?.trim().slice(0, 120) ?? "";
			const rel = path.relative(root, abs);
			simHits.push(`(sim) ${rel}${preview ? ` — ${preview}` : ""}`);
		}

		const baseLines =
			base.startsWith("No notes matching") || !base ? [] : base.split("\n");
		const keptLines = baseLines.filter((line) => {
			const rel = line.split(" — ")[0]?.trim();
			return rel ? !deletedRels.has(rel) : true;
		});
		const combined = [...keptLines, ...simHits];
		return combined.length > 0
			? combined.join("\n")
			: `No notes matching "${input.query}".`;
	},
	sideEffect: "pure",
	kind: "builtin",
	capability: "resource",
};

// ─── list ────────────────────────────────────────────────────────────────────

const vaultListSchema = z.object({
	directory: z
		.string()
		.optional()
		.default("")
		.describe('Relative directory path, e.g. "Projects" or "" for root'),
	depth: z
		.number()
		.optional()
		.default(2)
		.describe("How many levels deep to list (max 5)"),
});

export const vaultListTool: ToolDefinition<typeof vaultListSchema> = {
	name: "vault_list",
	description:
		"Browse the directory structure of the vault. Returns a tree of folders and .md files. When called with no directory, shows all accessible folders.",
	inputSchema: vaultListSchema,
	execute: async ({ directory, depth: rawDepth }, context) => {
		const depth = Math.min(rawDepth, 5);

		// No directory specified → show accessible top-level structure
		if (!directory) {
			const readable = getReadableFolders(vaultMap(context));
			const MAX_ENTRIES = settings.vault.maxList;
			const lines: string[] = [];

			for (const { absolutePath } of readable) {
				const folderName = path.relative(vaultRoot(), absolutePath) || ".";
				if (folderName !== ".") {
					lines.push(`${folderName}/`);
				}
				const remaining = MAX_ENTRIES - lines.length;
				if (remaining <= 0) break;
				await walkDir(
					absolutePath,
					depth,
					remaining,
					lines,
					folderName === "." ? 0 : 1,
				);
			}

			return lines.length > 0 ? lines.join("\n") : "Empty vault.";
		}

		// Specific directory requested
		const effectiveDir = directory || "";
		const result = await gate(effectiveDir, "read", context);
		if (typeof result === "object") return result.error;

		const MAX_ENTRIES = settings.vault.maxList;
		const lines: string[] = [];
		await walkDir(result, depth, MAX_ENTRIES, lines, 0);
		return lines.length > 0 ? lines.join("\n") : "Empty directory.";
	},
	simulate: async (input, context) => {
		const base = await vaultListTool.execute(input, context);
		if (typeof base !== "string") return base;
		const overlay = getOverlay(context);
		if (overlay.vaultWrites.size === 0 && overlay.vaultDeletes.size === 0) {
			return base;
		}
		const root = vaultRoot();
		const targetDir = input.directory ? path.join(root, input.directory) : root;
		const scope = (abs: string): boolean =>
			abs === targetDir || abs.startsWith(`${targetDir}${path.sep}`);
		const additions = [...overlay.vaultWrites.keys()]
			.filter(scope)
			.map((abs) => path.relative(root, abs));
		const deletions = [...overlay.vaultDeletes]
			.filter(scope)
			.map((abs) => path.relative(root, abs));
		if (additions.length === 0 && deletions.length === 0) return base;
		const notes: string[] = [];
		if (additions.length > 0)
			notes.push(`[sim +${additions.length}: ${additions.join(", ")}]`);
		if (deletions.length > 0)
			notes.push(`[sim -${deletions.length}: ${deletions.join(", ")}]`);
		return `${base}\n${notes.join("\n")}`;
	},
	sideEffect: "pure",
	kind: "builtin",
	capability: "resource",
};

async function walkDir(
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
			remaining = await walkDir(
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

// ─── findSection helper ──────────────────────────────────────────────────────

/**
 * Locate a heading section in a markdown document.
 * - Named heading (non-empty): finds the heading line and its content range.
 * - Top-level section (empty string): returns the range before the first heading (after frontmatter).
 */
export function findSection(
	lines: string[],
	heading: string,
): { headingIdx: number; level: number; endIdx: number } | null {
	if (heading === "") {
		let startIdx = 0;
		if (lines[0]?.trimEnd() === "---") {
			for (let i = 1; i < lines.length; i++) {
				if ((lines[i] ?? "").trimEnd() === "---") {
					startIdx = i + 1;
					break;
				}
			}
		}
		let firstHeading = lines.length;
		for (let i = startIdx; i < lines.length; i++) {
			if (/^#{1,6}\s/.test(lines[i] ?? "")) {
				firstHeading = i;
				break;
			}
		}
		return { headingIdx: -1, level: 0, endIdx: firstHeading };
	}

	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const headingPattern = new RegExp(`^(#{1,6})\\s+${escaped}\\s*$`, "i");

	const headingIdx = lines.findIndex((l) => headingPattern.test(l));
	if (headingIdx === -1) return null;

	const headingLine = lines[headingIdx] ?? "";
	const level = ((headingLine.match(/^(#+)/) ?? ["", ""])[1] ?? "").length;
	const sameOrHigher = new RegExp(`^#{1,${level}}\\s`);
	let endIdx = lines.length;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		if (sameOrHigher.test(lines[i] ?? "")) {
			endIdx = i;
			break;
		}
	}

	return { headingIdx, level, endIdx };
}

/** List all headings in a document (for error messages and outline). */
export function listHeadings(
	lines: string[],
): Array<{ text: string; level: number; lineIdx: number }> {
	const headings: Array<{ text: string; level: number; lineIdx: number }> = [];
	for (let i = 0; i < lines.length; i++) {
		const match = (lines[i] ?? "").match(/^(#{1,6})\s+(.+?)\s*$/);
		if (match) {
			headings.push({
				text: match[2] ?? "",
				level: (match[1] ?? "").length,
				lineIdx: i,
			});
		}
	}
	return headings;
}

// ─── write ───────────────────────────────────────────────────────────────────

const vaultWriteSchema = z.object({
	path: z
		.string()
		.describe(
			'Relative path including .md extension, e.g. "Projects/New Note.md"',
		),
	content: z
		.string()
		.describe(
			"Full markdown content of the note (including frontmatter if desired)",
		),
});

export const vaultWriteTool: ToolDefinition<typeof vaultWriteSchema> = {
	name: "vault_write",
	description:
		"Create or override a note in the vault. Parent directories are created automatically. overrideS the entire file — read first with vault_read if you need to preserve existing content.",
	inputSchema: vaultWriteSchema,
	execute: async ({ path: rel, content }, context) => {
		const result = await gate(rel, "full", context);
		if (typeof result === "object") return result.error;

		await mkdir(path.dirname(result), { recursive: true });
		await Bun.write(result, content);
		return `Written: ${rel}`;
	},
	simulate: async ({ path: rel, content }, context) => {
		const gated = await gate(rel, "full", context);
		if (typeof gated === "object") return gated.error;
		const overlay = getOverlay(context);
		overlay.vaultWrites.set(gated, content);
		overlay.vaultDeletes.delete(gated);
		return `(sim) Written: ${rel}`;
	},
	requiresConfirmation: vaultConfirm("write", "full"),
	sideEffect: "stateful",
	kind: "builtin",
	capability: "tool",
};

// ─── append ──────────────────────────────────────────────────────────────────

const vaultAppendSchema = z.object({
	path: z.string().describe("Relative path to the note to append to"),
	content: z.string().describe("Content to append (added after a newline)"),
	heading: z
		.string()
		.optional()
		.describe(
			'Optional heading to append inside. Omit for EOF. Use "" for top-level section (before first heading). Use exact heading text without # markers for a named section.',
		),
});

export const vaultAppendTool: ToolDefinition<typeof vaultAppendSchema> = {
	name: "vault_append",
	description:
		"Append content to an existing note (useful for daily notes, logs, inboxes). Creates the file if it does not exist. For structured notes with sections, set the heading parameter to append inside a specific section — use vault_outline first to see available sections.",
	inputSchema: vaultAppendSchema,
	execute: async ({ path: rel, content, heading }, context) => {
		const result = await gate(rel, "append", context);
		if (typeof result === "object") return result.error;

		let existing = "";
		try {
			existing = await Bun.file(result).text();
		} catch {
			await mkdir(path.dirname(result), { recursive: true });
		}

		if (heading === undefined) {
			const newContent = existing ? `${existing}\n${content}` : content;
			await Bun.write(result, newContent);
			return `Appended to: ${rel}`;
		}

		if (!existing) {
			await Bun.write(result, content);
			return `Appended to: ${rel}`;
		}

		const lines = existing.split("\n");
		const section = findSection(lines, heading);

		if (!section) {
			const available = listHeadings(lines);
			const headingList =
				available.length > 0
					? available.map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n")
					: "(no headings)";
			return `Heading "${heading}" not found in ${rel}. Available headings:\n${headingList}`;
		}

		const before = lines.slice(0, section.endIdx);
		const after = lines.slice(section.endIdx);
		const updated = [...before, content, ...after].join("\n");
		await Bun.write(result, updated);
		return `Appended to section ${heading === "" ? "(top-level)" : `"${heading}"`} in: ${rel}`;
	},
	simulate: async ({ path: rel, content, heading }, context) => {
		const gated = await gate(rel, "append", context);
		if (typeof gated === "object") return gated.error;
		const overlay = getOverlay(context);
		const existing = (await simReadContent(gated, overlay)) ?? "";

		if (heading === undefined) {
			overlay.vaultWrites.set(
				gated,
				existing ? `${existing}\n${content}` : content,
			);
			overlay.vaultDeletes.delete(gated);
			return `(sim) Appended to: ${rel}`;
		}

		if (!existing) {
			overlay.vaultWrites.set(gated, content);
			overlay.vaultDeletes.delete(gated);
			return `(sim) Appended to: ${rel}`;
		}

		const lines = existing.split("\n");
		const section = findSection(lines, heading);
		if (!section) {
			const available = listHeadings(lines);
			const headingList =
				available.length > 0
					? available.map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n")
					: "(no headings)";
			return `Heading "${heading}" not found in ${rel}. Available headings:\n${headingList}`;
		}
		const before = lines.slice(0, section.endIdx);
		const after = lines.slice(section.endIdx);
		overlay.vaultWrites.set(gated, [...before, content, ...after].join("\n"));
		overlay.vaultDeletes.delete(gated);
		return `(sim) Appended to section ${heading === "" ? "(top-level)" : `"${heading}"`} in: ${rel}`;
	},
	requiresConfirmation: vaultConfirm("append to", "append"),
	sideEffect: "stateful",
	kind: "builtin",
	capability: "tool",
};

// ─── backlinks ───────────────────────────────────────────────────────────────

const vaultBacklinksSchema = z.object({
	noteName: z
		.string()
		.describe('Note name without .md extension, e.g. "Klaus"'),
});

export const vaultBacklinksTool: ToolDefinition<typeof vaultBacklinksSchema> = {
	name: "vault_backlinks",
	description:
		"Find all notes that link to a given note via [[wikilinks]]. Returns file paths with the linking line.",
	inputSchema: vaultBacklinksSchema,
	execute: async ({ noteName }, context) => {
		const glob = new Bun.Glob("**/*.md");
		const pattern = new RegExp(
			`\\[\\[${noteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\|[^\\]]*)?\\]\\]`,
			"i",
		);
		const readable = getReadableFolders(vaultMap(context));
		const results: string[] = [];

		for (const { absolutePath } of readable) {
			for await (const file of glob.scan({ cwd: absolutePath })) {
				try {
					const text = await Bun.file(path.join(absolutePath, file)).text();
					const lines = text.split("\n");
					const match = lines.find((l) => pattern.test(l));
					if (match) {
						const vaultRel = path.relative(
							vaultRoot(),
							path.join(absolutePath, file),
						);
						results.push(`${vaultRel} — ${match.trim().slice(0, 120)}`);
					}
				} catch {
					// Skip unreadable files
				}
			}
		}

		return results.length > 0
			? results.join("\n")
			: `No backlinks found for "${noteName}".`;
	},
	sideEffect: "pure",
	kind: "builtin",
	capability: "resource",
};

// ─── move ────────────────────────────────────────────────────────────────────

const vaultMoveSchema = z.object({
	from: z
		.string()
		.describe('Source relative path, e.g. "Projects/Old Name.md"'),
	to: z
		.string()
		.describe('Destination relative path, e.g. "Archive/Old Name.md"'),
	updateBacklinks: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			"If true, scan all notes and rewrite [[wikilinks]] pointing to the old name",
		),
});

export const vaultMoveTool: ToolDefinition<typeof vaultMoveSchema> = {
	name: "vault_move",
	description:
		"Move or rename a note within the vault. Optionally updates all [[wikilinks]] across the vault that referenced the old name.",
	inputSchema: vaultMoveSchema,
	execute: async ({ from, to, updateBacklinks }, context) => {
		// Both source (delete) and destination (create) need full permission
		const srcResult = await gate(from, "full", context);
		if (typeof srcResult === "object") return srcResult.error;
		const dstResult = await gate(to, "full", context);
		if (typeof dstResult === "object") return dstResult.error;

		try {
			await mkdir(path.dirname(dstResult), { recursive: true });
			await rename(srcResult, dstResult);
		} catch {
			return `Failed to move "${from}" — file may not exist or destination is occupied.`;
		}

		if (!updateBacklinks) return `Moved: ${from} → ${to}`;

		const oldName = path.basename(from, ".md");
		const newName = path.basename(to, ".md");
		const glob = new Bun.Glob("**/*.md");
		const pattern = new RegExp(
			`\\[\\[${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\|[^\\]]*)?\\]\\]`,
			"gi",
		);

		let updatedCount = 0;
		const skipped: string[] = [];
		const readable = getReadableFolders(vaultMap(context));

		for (const { folder, absolutePath } of readable) {
			// Only update backlinks in folders where we have default write access
			const canWrite =
				checkPermission(folder, "full", vaultMap(context)) === "allowed";

			for await (const file of glob.scan({ cwd: absolutePath })) {
				const filePath = path.join(absolutePath, file);
				try {
					const text = await Bun.file(filePath).text();
					const updated = text.replace(pattern, `[[${newName}$1]]`);
					if (updated !== text) {
						if (canWrite) {
							await Bun.write(filePath, updated);
							updatedCount++;
						} else {
							const vaultRel = path.relative(vaultRoot(), filePath);
							skipped.push(vaultRel);
						}
					}
				} catch {
					// Skip unreadable files
				}
			}
		}

		let msg = `Moved: ${from} → ${to}. Updated backlinks in ${updatedCount} note(s).`;
		if (skipped.length > 0) {
			msg += `\nSkipped (no write permission): ${skipped.join(", ")}`;
		}
		return msg;
	},
	simulate: async ({ from, to, updateBacklinks }, context) => {
		const srcGated = await gate(from, "full", context);
		if (typeof srcGated === "object") return srcGated.error;
		const dstGated = await gate(to, "full", context);
		if (typeof dstGated === "object") return dstGated.error;
		const overlay = getOverlay(context);
		const content = await simReadContent(srcGated, overlay);
		if (content === null) {
			return `Failed to move "${from}" — file not found.`;
		}
		overlay.vaultWrites.set(dstGated, content);
		overlay.vaultDeletes.delete(dstGated);
		overlay.vaultDeletes.add(srcGated);
		overlay.vaultWrites.delete(srcGated);
		const backlinkNote = updateBacklinks
			? " Backlink rewrites skipped under sim."
			: "";
		return `(sim) Moved: ${from} → ${to}.${backlinkNote}`;
	},
	requiresConfirmation: (input, context) => {
		// Treat the destination as the gate target; that's where the new
		// content lands. The source's own deletion is implicit.
		const fromCheck = vaultConfirm("move from", "full")(
			{ path: input.from },
			context,
		);
		if (fromCheck) return fromCheck;
		return vaultConfirm("move to", "full")({ path: input.to }, context);
	},
	sideEffect: "stateful",
	kind: "builtin",
	capability: "tool",
};

// ─── delete ──────────────────────────────────────────────────────────────────

const vaultDeleteSchema = z.object({
	path: z.string().describe("Relative path to the note to delete"),
});

export const vaultDeleteTool: ToolDefinition<typeof vaultDeleteSchema> = {
	name: "vault_delete",
	description:
		"Permanently delete a note from the vault. The framework asks the user to confirm before this runs (unless the agent has auto-accept on or the folder permission allows full access without confirmation).",
	inputSchema: vaultDeleteSchema,
	execute: async ({ path: rel }, context) => {
		const result = await gate(rel, "full", context);
		if (typeof result === "object") return result.error;

		try {
			await unlink(result);
			return `Deleted: ${rel}`;
		} catch {
			return `Note not found or could not be deleted: ${rel}`;
		}
	},
	simulate: async ({ path: rel }, context) => {
		const gated = await gate(rel, "full", context);
		if (typeof gated === "object") return gated.error;
		const overlay = getOverlay(context);
		overlay.vaultDeletes.add(gated);
		overlay.vaultWrites.delete(gated);
		return `(sim) Deleted: ${rel}`;
	},
	requiresConfirmation: vaultConfirm("delete", "full"),
	sideEffect: "stateful",
	kind: "builtin",
	capability: "tool",
};

// ─── patch ───────────────────────────────────────────────────────────────────

const vaultPatchSchema = z.object({
	path: z.string().describe("Relative path to the note"),
	heading: z
		.string()
		.describe('Exact heading text without # markers, e.g. "Goals" or "Notes"'),
	newContent: z
		.string()
		.describe(
			"Replacement content for the section body (heading line is preserved)",
		),
});

export const vaultPatchTool: ToolDefinition<typeof vaultPatchSchema> = {
	name: "vault_patch",
	description:
		"Replace the body of a specific section in a note by heading. The heading line is kept; everything beneath it until the next same-or-higher-level heading (or EOF) is replaced. Read the note first with vault_read to see current content before replacing.",
	inputSchema: vaultPatchSchema,
	execute: async ({ path: rel, heading, newContent }, context) => {
		const result = await gate(rel, "full", context);
		if (typeof result === "object") return result.error;

		let text: string;
		try {
			text = await Bun.file(result).text();
		} catch {
			return `Note not found: ${rel}`;
		}

		const lines = text.split("\n");
		const section = findSection(lines, heading);
		if (!section) return `Heading "${heading}" not found in ${rel}.`;

		const updated = [
			...lines.slice(0, section.headingIdx + 1),
			newContent,
			...lines.slice(section.endIdx),
		].join("\n");
		await Bun.write(result, updated);
		return `Patched section "${heading}" in ${rel}.`;
	},
	simulate: async ({ path: rel, heading, newContent }, context) => {
		const gated = await gate(rel, "full", context);
		if (typeof gated === "object") return gated.error;
		const overlay = getOverlay(context);
		const existing = await simReadContent(gated, overlay);
		if (existing === null) return `Note not found: ${rel}`;
		const lines = existing.split("\n");
		const section = findSection(lines, heading);
		if (!section) return `Heading "${heading}" not found in ${rel}.`;
		const updated = [
			...lines.slice(0, section.headingIdx + 1),
			newContent,
			...lines.slice(section.endIdx),
		].join("\n");
		overlay.vaultWrites.set(gated, updated);
		overlay.vaultDeletes.delete(gated);
		return `(sim) Patched section "${heading}" in ${rel}.`;
	},
	requiresConfirmation: vaultConfirm("patch", "full"),
	sideEffect: "stateful",
	kind: "builtin",
	capability: "tool",
};

// ─── tags ────────────────────────────────────────────────────────────────────

const vaultTagsSchema = z.object({
	tags: z
		.array(z.string())
		.optional()
		.describe("Return notes that have any of these tags in their frontmatter"),
	list: z
		.boolean()
		.optional()
		.default(false)
		.describe("If true, return all unique tags across the vault instead"),
});

export const vaultTagsTool: ToolDefinition<typeof vaultTagsSchema> = {
	name: "vault_tags",
	description:
		"Find notes by frontmatter tag, or list all tags used across the vault. Use list: true to discover available tags.",
	inputSchema: vaultTagsSchema,
	execute: async ({ tags, list }, context) => {
		const glob = new Bun.Glob("**/*.md");
		const readable = getReadableFolders(vaultMap(context));
		const fmPattern = /^---\n([\s\S]*?)\n---/;

		function extractTags(text: string): string[] {
			const fm = text.match(fmPattern)?.[1] ?? "";
			const inline = fm.match(/^tags:\s*\[([^\]]*)\]/m)?.[1];
			if (inline)
				return inline
					.split(",")
					.map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
					.filter(Boolean);
			const block = [...fm.matchAll(/^tags:\s*\n((?:\s+-\s+.+\n?)*)/gm)];
			if (block.length) {
				const blockBody = block[0]?.[1] ?? "";
				return [...blockBody.matchAll(/^\s+-\s+(.+)/gm)].map((m) =>
					(m[1] ?? "").trim(),
				);
			}
			return [];
		}

		if (list) {
			const allTags = new Set<string>();
			for (const { absolutePath } of readable) {
				for await (const file of glob.scan({ cwd: absolutePath })) {
					try {
						const text = await Bun.file(path.join(absolutePath, file)).text();
						for (const t of extractTags(text)) allTags.add(t);
					} catch {
						// Skip unreadable files
					}
				}
			}
			return allTags.size > 0
				? [...allTags].sort().join("\n")
				: "No tags found.";
		}

		if (!tags || tags.length === 0)
			return "Provide tags to search for, or set list: true.";

		const searchTags = new Set(tags.map((t) => t.toLowerCase()));
		const results: string[] = [];
		for (const { absolutePath } of readable) {
			for await (const file of glob.scan({ cwd: absolutePath })) {
				try {
					const text = await Bun.file(path.join(absolutePath, file)).text();
					const noteTags = extractTags(text).map((t) => t.toLowerCase());
					if (noteTags.some((t) => searchTags.has(t))) {
						const vaultRel = path.relative(
							vaultRoot(),
							path.join(absolutePath, file),
						);
						results.push(vaultRel);
					}
				} catch {
					// Skip unreadable files
				}
			}
		}

		return results.length > 0
			? results.join("\n")
			: `No notes tagged with: ${tags.join(", ")}.`;
	},
	sideEffect: "pure",
	kind: "builtin",
	capability: "resource",
};

// ─── links ───────────────────────────────────────────────────────────────────

const vaultLinksSchema = z.object({
	path: z.string().describe("Relative path to the note"),
});

export const vaultLinksTool: ToolDefinition<typeof vaultLinksSchema> = {
	name: "vault_links",
	description:
		"Extract all outgoing [[wikilinks]] from a note. Complements vault_backlinks for graph traversal.",
	inputSchema: vaultLinksSchema,
	execute: async ({ path: rel }, context) => {
		const result = await gate(rel, "read", context);
		if (typeof result === "object") return result.error;

		let text: string;
		try {
			text = await Bun.file(result).text();
		} catch {
			return `Note not found: ${rel}`;
		}

		const pattern = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
		const targets = new Set<string>();
		for (const match of text.matchAll(pattern)) {
			if (match[1]) targets.add(match[1].trim());
		}

		return targets.size > 0
			? [...targets].sort().join("\n")
			: `No outgoing links in "${rel}".`;
	},
	sideEffect: "pure",
	kind: "builtin",
	capability: "resource",
};

// ─── outline ─────────────────────────────────────────────────────────────────

const vaultOutlineSchema = z.object({
	path: z.string().describe("Relative path to the note"),
});

export const vaultOutlineTool: ToolDefinition<typeof vaultOutlineSchema> = {
	name: "vault_outline",
	description:
		"Return the heading structure of a note with item counts per section. Use before vault_append or vault_patch to see available sections without reading the full note.",
	inputSchema: vaultOutlineSchema,
	execute: async ({ path: rel }, context) => {
		const result = await gate(rel, "read", context);
		if (typeof result === "object") return result.error;

		let text: string;
		try {
			text = await Bun.file(result).text();
		} catch {
			return `Note not found: ${rel}`;
		}

		const lines = text.split("\n");
		const headings = listHeadings(lines);

		if (headings.length === 0) {
			const nonEmpty = lines.filter((l) => l.trim().length > 0).length;
			return nonEmpty > 0 ? `(no headings, ${nonEmpty} lines)` : "(empty file)";
		}

		const outlineResult: string[] = [];

		const topSection = findSection(lines, "");
		if (topSection) {
			const topLines = lines
				.slice(Math.max(topSection.headingIdx + 1, 0), topSection.endIdx)
				.filter((l) => l.trim().length > 0).length;
			if (topLines > 0) {
				outlineResult.push(
					`(top-level: ${topLines} ${topLines === 1 ? "line" : "lines"})`,
				);
			}
		}

		for (let i = 0; i < headings.length; i++) {
			const h = headings[i];
			if (!h) continue;
			const nextIdx =
				i + 1 < headings.length
					? (headings[i + 1]?.lineIdx ?? lines.length)
					: lines.length;
			const contentLines = lines
				.slice(h.lineIdx + 1, nextIdx)
				.filter((l) => l.trim().length > 0).length;
			const prefix = "#".repeat(h.level);
			outlineResult.push(
				`${prefix} ${h.text} (${contentLines} ${contentLines === 1 ? "item" : "items"})`,
			);
		}

		return outlineResult.join("\n");
	},
	sideEffect: "pure",
	kind: "builtin",
	capability: "resource",
};

// ─── toolset export ──────────────────────────────────────────────────────────

export const vaultToolset: ToolsetDefinition = {
	name: "vault",
	description:
		"Use when the request involves Jan's vault — his personal markdown note system for projects, ideas, journal entries, reference material, and second-brain content. The vault has multiple folders with different permission levels (some read-only, some full access, some requiring confirmation for writes). Notes are memory, [[wikilinks]] are relationships, frontmatter tags enable discovery. Use for anything that sounds like a note, a document, something to remember, or something Jan would have written down. Prefer read-before-write: use vault_read or vault_outline before modifying notes to understand structure, language, and existing content.",
	tools: [
		vaultReadTool,
		vaultSearchTool,
		vaultListTool,
		vaultWriteTool,
		vaultAppendTool,
		vaultBacklinksTool,
		vaultMoveTool,
		vaultDeleteTool,
		vaultPatchTool,
		vaultTagsTool,
		vaultLinksTool,
		vaultOutlineTool,
	],
};
