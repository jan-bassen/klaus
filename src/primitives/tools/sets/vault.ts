import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { settings } from "@/infra/config";
import { getOverlay } from "@/infra/simulation";
import {
	checkPermission,
	getReadableFolders,
	type VaultOp,
} from "@/infra/vault";
import {
	extractFrontmatterTags,
	extractWikilinks,
	findSection,
	listHeadings,
	wikilinkTargetPattern,
} from "@/infra/vault/markdown";
import {
	gateVaultTool,
	readSimulatedVaultContent,
	vaultMap,
	vaultRoot,
	walkVaultDir,
} from "@/infra/vault/tools";
import type { TurnContext } from "@/pipeline/core";
import type { ToolDefinition, ToolsetDefinition } from "@/primitives/tools";

interface AppendUpdate {
	content: string;
	message: string;
	simMessage: string;
}

function formatHeadingList(lines: string[]): string {
	const available = listHeadings(lines);
	return available.length > 0
		? available.map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n")
		: "(no headings)";
}

function buildAppendUpdate(
	existing: string,
	content: string,
	heading: string | undefined,
	rel: string,
): AppendUpdate | string {
	if (heading === undefined) {
		return {
			content: existing ? `${existing}\n${content}` : content,
			message: `Appended to: ${rel}`,
			simMessage: `(sim) Appended to: ${rel}`,
		};
	}

	if (!existing) {
		return {
			content,
			message: `Appended to: ${rel}`,
			simMessage: `(sim) Appended to: ${rel}`,
		};
	}

	const lines = existing.split("\n");
	const section = findSection(lines, heading);

	if (!section) {
		return `Heading "${heading}" not found in ${rel}. Available headings:\n${formatHeadingList(
			lines,
		)}`;
	}

	const before = lines.slice(0, section.endIdx);
	const after = lines.slice(section.endIdx);
	const sectionName = heading === "" ? "(top-level)" : `"${heading}"`;
	return {
		content: [...before, content, ...after].join("\n"),
		message: `Appended to section ${sectionName} in: ${rel}`,
		simMessage: `(sim) Appended to section ${sectionName} in: ${rel}`,
	};
}

async function readVaultNote(
	rel: string,
	op: VaultOp,
	context: TurnContext,
): Promise<{ absolutePath: string; text: string } | string> {
	const result = await gateVaultTool(rel, op, context);
	if (typeof result === "object") return result.error;

	try {
		return {
			absolutePath: result,
			text: await Bun.file(result).text(),
		};
	} catch {
		return `Note not found: ${rel}`;
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
		const result = await gateVaultTool(rel, "read", context);
		if (typeof result === "object") return result.error;

		try {
			return await Bun.file(result).text();
		} catch {
			return `Note not found: ${rel}`;
		}
	},
	simulate: async ({ path: rel }, context) => {
		const gated = await gateVaultTool(rel, "read", context);
		if (typeof gated === "object") return gated.error;
		const content = await readSimulatedVaultContent(gated, getOverlay(context));
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
				await walkVaultDir(
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
		const result = await gateVaultTool(effectiveDir, "read", context);
		if (typeof result === "object") return result.error;

		const MAX_ENTRIES = settings.vault.maxList;
		const lines: string[] = [];
		await walkVaultDir(result, depth, MAX_ENTRIES, lines, 0);
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
		const result = await gateVaultTool(rel, "full", context);
		if (typeof result === "object") return result.error;

		await mkdir(path.dirname(result), { recursive: true });
		await Bun.write(result, content);
		return `Written: ${rel}`;
	},
	simulate: async ({ path: rel, content }, context) => {
		const gated = await gateVaultTool(rel, "full", context);
		if (typeof gated === "object") return gated.error;
		const overlay = getOverlay(context);
		overlay.vaultWrites.set(gated, content);
		overlay.vaultDeletes.delete(gated);
		return `(sim) Written: ${rel}`;
	},
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
		const result = await gateVaultTool(rel, "append", context);
		if (typeof result === "object") return result.error;

		let existing = "";
		try {
			existing = await Bun.file(result).text();
		} catch {
			await mkdir(path.dirname(result), { recursive: true });
		}

		const updated = buildAppendUpdate(existing, content, heading, rel);
		if (typeof updated === "string") return updated;
		await Bun.write(result, updated.content);
		return updated.message;
	},
	simulate: async ({ path: rel, content, heading }, context) => {
		const gated = await gateVaultTool(rel, "append", context);
		if (typeof gated === "object") return gated.error;
		const overlay = getOverlay(context);
		const existing = (await readSimulatedVaultContent(gated, overlay)) ?? "";

		const updated = buildAppendUpdate(existing, content, heading, rel);
		if (typeof updated === "string") return updated;
		overlay.vaultWrites.set(gated, updated.content);
		overlay.vaultDeletes.delete(gated);
		return updated.simMessage;
	},
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
		const pattern = wikilinkTargetPattern(noteName);
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
		const srcResult = await gateVaultTool(from, "full", context);
		if (typeof srcResult === "object") return srcResult.error;
		const dstResult = await gateVaultTool(to, "full", context);
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
		const pattern = wikilinkTargetPattern(oldName, "gi");

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
		const srcGated = await gateVaultTool(from, "full", context);
		if (typeof srcGated === "object") return srcGated.error;
		const dstGated = await gateVaultTool(to, "full", context);
		if (typeof dstGated === "object") return dstGated.error;
		const overlay = getOverlay(context);
		const content = await readSimulatedVaultContent(srcGated, overlay);
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
		const result = await gateVaultTool(rel, "full", context);
		if (typeof result === "object") return result.error;

		try {
			await unlink(result);
			return `Deleted: ${rel}`;
		} catch {
			return `Note not found or could not be deleted: ${rel}`;
		}
	},
	simulate: async ({ path: rel }, context) => {
		const gated = await gateVaultTool(rel, "full", context);
		if (typeof gated === "object") return gated.error;
		const overlay = getOverlay(context);
		overlay.vaultDeletes.add(gated);
		overlay.vaultWrites.delete(gated);
		return `(sim) Deleted: ${rel}`;
	},
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
		const note = await readVaultNote(rel, "full", context);
		if (typeof note === "string") return note;

		const lines = note.text.split("\n");
		const section = findSection(lines, heading);
		if (!section) return `Heading "${heading}" not found in ${rel}.`;

		const updated = [
			...lines.slice(0, section.headingIdx + 1),
			newContent,
			...lines.slice(section.endIdx),
		].join("\n");
		await Bun.write(note.absolutePath, updated);
		return `Patched section "${heading}" in ${rel}.`;
	},
	simulate: async ({ path: rel, heading, newContent }, context) => {
		const gated = await gateVaultTool(rel, "full", context);
		if (typeof gated === "object") return gated.error;
		const overlay = getOverlay(context);
		const existing = await readSimulatedVaultContent(gated, overlay);
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

		if (list) {
			const allTags = new Set<string>();
			for (const { absolutePath } of readable) {
				for await (const file of glob.scan({ cwd: absolutePath })) {
					try {
						const text = await Bun.file(path.join(absolutePath, file)).text();
						for (const t of extractFrontmatterTags(text)) allTags.add(t);
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
					const noteTags = extractFrontmatterTags(text).map((t) =>
						t.toLowerCase(),
					);
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
		const note = await readVaultNote(rel, "read", context);
		if (typeof note === "string") return note;

		const targets = extractWikilinks(note.text);

		return targets.length > 0
			? targets.join("\n")
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
		const note = await readVaultNote(rel, "read", context);
		if (typeof note === "string") return note;

		const lines = note.text.split("\n");
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
