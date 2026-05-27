import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { settings } from "../../../infra/config.ts";
import { readText, scanFiles, writeData } from "../../../infra/runtime.ts";
import {
	checkPermission,
	getReadableFolders,
	type VaultOp,
} from "../../../infra/vault/index.ts";
import {
	extractFrontmatterTags,
	extractWikilinks,
	findSection,
	listHeadings,
	wikilinkTargetPattern,
} from "../../../infra/vault/markdown.ts";
import {
	gateVaultTool,
	vaultMap,
	vaultRoot,
	walkVaultDir,
} from "../../../infra/vault/tools.ts";
import type { TurnContext } from "../../../pipeline/core.ts";
import type { ToolDefinition, ToolsetDefinition } from "../index.ts";

interface AppendUpdate {
	content: string;
	message: string;
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
		};
	}

	if (!existing) {
		return {
			content,
			message: `Appended to: ${rel}`,
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
			text: await readText(result),
		};
	} catch {
		return `Note not found: ${rel}`;
	}
}

// ─── read ────────────────────────────────────────────────────────────────────

const vaultReadSchema = z.object({
	path: z
		.string({ error: "path must be the vault-relative note path to read." })
		.min(1, { error: "path must be the vault-relative note path to read." })
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
			return await readText(result);
		} catch {
			return `Note not found: ${rel}`;
		}
	},
};

// ─── search ──────────────────────────────────────────────────────────────────

const vaultSearchSchema = z.object({
	query: z
		.string({ error: "query must include search text." })
		.min(1, { error: "query must include search text." })
		.describe(
			"Search terms (case-insensitive substring match across all notes)",
		),
	limit: z
		.number({ error: "limit must be a whole number." })
		.int({ error: "limit must be a whole number." })
		.min(1, { error: "limit must be at least 1." })
		.optional()
		.default(10)
		.describe("Max results to return"),
});

export const vaultSearchTool: ToolDefinition<typeof vaultSearchSchema> = {
	name: "vault_search",
	description:
		"Full-text search across all markdown notes in the vault. Returns matching file paths with context lines.",
	inputSchema: vaultSearchSchema,
	execute: async ({ query, limit }, context) => {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (terms.length === 0) return "Empty query.";

		const readable = getReadableFolders(vaultMap(context));
		const results: string[] = [];

		for (const { absolutePath } of readable) {
			if (results.length >= limit) break;

			for await (const file of scanFiles(absolutePath, "**/*.md")) {
				if (results.length >= limit) break;

				try {
					const text = await readText(path.join(absolutePath, file));
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
};

// ─── list ────────────────────────────────────────────────────────────────────

const vaultListSchema = z.object({
	directory: z
		.string()
		.optional()
		.default("")
		.describe('Relative directory path, e.g. "Projects" or "" for root'),
	depth: z
		.number({ error: "depth must be a whole number." })
		.int({ error: "depth must be a whole number." })
		.nonnegative({ error: "depth must be 0 or greater." })
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
};

// ─── write ───────────────────────────────────────────────────────────────────

const vaultWriteSchema = z.object({
	path: z
		.string({ error: "path must be the vault-relative note path to write." })
		.min(1, { error: "path must be the vault-relative note path to write." })
		.describe(
			'Relative path including .md extension, e.g. "Projects/New Note.md"',
		),
	content: z
		.string({ error: "content must be the markdown to write." })
		.min(1, { error: "content must be the markdown to write." })
		.describe(
			"Full markdown content of the note (including frontmatter if desired)",
		),
});

export const vaultWriteTool: ToolDefinition<typeof vaultWriteSchema> = {
	name: "vault_write",
	description:
		"Create or overwrite a note in the vault. Parent directories are created automatically. Overwrites the entire file — read first with vault_read if you need to preserve existing content.",
	inputSchema: vaultWriteSchema,
	execute: async ({ path: rel, content }, context) => {
		const result = await gateVaultTool(rel, "full", context);
		if (typeof result === "object") return result.error;

		await mkdir(path.dirname(result), { recursive: true });
		await writeData(result, content);
		return `Written: ${rel}`;
	},
};

// ─── append ──────────────────────────────────────────────────────────────────

const vaultAppendSchema = z.object({
	path: z
		.string({
			error: "path must be the vault-relative note path to append to.",
		})
		.min(1, {
			error: "path must be the vault-relative note path to append to.",
		})
		.describe("Relative path to the note to append to"),
	content: z
		.string({ error: "content must be the markdown to append." })
		.min(1, { error: "content must be the markdown to append." })
		.describe("Content to append (added after a newline)"),
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
			existing = await readText(result);
		} catch {
			await mkdir(path.dirname(result), { recursive: true });
		}

		const updated = buildAppendUpdate(existing, content, heading, rel);
		if (typeof updated === "string") return updated;
		await writeData(result, updated.content);
		return updated.message;
	},
};

// ─── backlinks ───────────────────────────────────────────────────────────────

const vaultBacklinksSchema = z.object({
	noteTitle: z
		.string({ error: "noteTitle must be the linked note title to search for." })
		.min(1, { error: "noteTitle must be the linked note title to search for." })
		.describe('Note name without .md extension, e.g. "Klaus"'),
});

export const vaultBacklinksTool: ToolDefinition<typeof vaultBacklinksSchema> = {
	name: "vault_backlinks",
	description:
		"Find all notes that link to a given note via [[wikilinks]]. Returns file paths with the linking line.",
	inputSchema: vaultBacklinksSchema,
	execute: async ({ noteTitle }, context) => {
		const pattern = wikilinkTargetPattern(noteTitle);
		const readable = getReadableFolders(vaultMap(context));
		const results: string[] = [];

		for (const { absolutePath } of readable) {
			for await (const file of scanFiles(absolutePath, "**/*.md")) {
				try {
					const text = await readText(path.join(absolutePath, file));
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
			: `No backlinks found for "${noteTitle}".`;
	},
};

// ─── move ────────────────────────────────────────────────────────────────────

const vaultMoveSchema = z.object({
	oldPath: z
		.string({ error: "oldPath must be the source vault-relative path." })
		.min(1, { error: "oldPath must be the source vault-relative path." })
		.describe('Source relative path, e.g. "Projects/Old Name.md"'),
	newPath: z
		.string({ error: "newPath must be the destination vault-relative path." })
		.min(1, { error: "newPath must be the destination vault-relative path." })
		.describe('Destination relative path, e.g. "Archive/Old Name.md"'),
	updateLinks: z
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
	execute: async ({ oldPath, newPath, updateLinks }, context) => {
		// Both source (delete) and destination (create) need full permission
		const srcResult = await gateVaultTool(oldPath, "full", context);
		if (typeof srcResult === "object") return srcResult.error;
		const dstResult = await gateVaultTool(newPath, "full", context);
		if (typeof dstResult === "object") return dstResult.error;

		try {
			await mkdir(path.dirname(dstResult), { recursive: true });
			await rename(srcResult, dstResult);
		} catch {
			return `Failed to move "${oldPath}" — file may not exist or destination is occupied.`;
		}

		if (!updateLinks) return `Moved: ${oldPath} → ${newPath}`;

		const oldName = path.basename(oldPath, ".md");
		const newName = path.basename(newPath, ".md");
		const pattern = wikilinkTargetPattern(oldName, "gi");

		let updatedCount = 0;
		const skipped: string[] = [];
		const readable = getReadableFolders(vaultMap(context));

		for (const { folder, absolutePath } of readable) {
			// Only update backlinks in folders where we have default write access
			const canWrite =
				checkPermission(folder, "full", vaultMap(context)) === "allowed";

			for await (const file of scanFiles(absolutePath, "**/*.md")) {
				const filePath = path.join(absolutePath, file);
				try {
					const text = await readText(filePath);
					const updated = text.replace(pattern, `[[${newName}$1]]`);
					if (updated !== text) {
						if (canWrite) {
							await writeData(filePath, updated);
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

		let msg = `Moved: ${oldPath} → ${newPath}. Updated links in ${updatedCount} note(s).`;
		if (skipped.length > 0) {
			msg += `\nSkipped (no write permission): ${skipped.join(", ")}`;
		}
		return msg;
	},
};

// ─── delete ──────────────────────────────────────────────────────────────────

const vaultDeleteSchema = z.object({
	path: z
		.string({ error: "path must be the vault-relative note path to delete." })
		.min(1, { error: "path must be the vault-relative note path to delete." })
		.describe("Relative path to the note to delete"),
});

export const vaultDeleteTool: ToolDefinition<typeof vaultDeleteSchema> = {
	name: "vault_delete",
	description:
		"Permanently delete a note from the vault. Requires full access to the target folder.",
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
};

// ─── patch ───────────────────────────────────────────────────────────────────

const vaultPatchSchema = z.object({
	path: z
		.string({ error: "path must be the vault-relative note path to patch." })
		.min(1, { error: "path must be the vault-relative note path to patch." })
		.describe("Relative path to the note"),
	heading: z
		.string({ error: "heading must be the exact section heading to patch." })
		.min(1, { error: "heading must be the exact section heading to patch." })
		.describe('Exact heading text without # markers, e.g. "Goals" or "Notes"'),
	replacement: z
		.string({ error: "replacement must be the replacement section body." })
		.min(1, { error: "replacement must be the replacement section body." })
		.describe(
			"Replacement content for the section body (heading line is preserved)",
		),
});

export const vaultPatchTool: ToolDefinition<typeof vaultPatchSchema> = {
	name: "vault_patch",
	description:
		"Replace the body of a specific section in a note by heading. The heading line is kept; everything beneath it until the next same-or-higher-level heading (or EOF) is replaced. Read the note first with vault_read to see current content before replacing.",
	inputSchema: vaultPatchSchema,
	execute: async ({ path: rel, heading, replacement }, context) => {
		const note = await readVaultNote(rel, "full", context);
		if (typeof note === "string") return note;

		const lines = note.text.split("\n");
		const section = findSection(lines, heading);
		if (!section) return `Heading "${heading}" not found in ${rel}.`;

		const updated = [
			...lines.slice(0, section.headingIdx + 1),
			replacement,
			...lines.slice(section.endIdx),
		].join("\n");
		await writeData(note.absolutePath, updated);
		return `Patched section "${heading}" in ${rel}.`;
	},
};

// ─── tags ────────────────────────────────────────────────────────────────────

const vaultTagsSchema = z.object({
	tags: z
		.array(z.string())
		.optional()
		.describe("Return notes that have any of these tags in their frontmatter"),
	listAll: z
		.boolean()
		.optional()
		.default(false)
		.describe("If true, return all unique tags across the vault instead"),
});

export const vaultTagsTool: ToolDefinition<typeof vaultTagsSchema> = {
	name: "vault_tags",
	description:
		"Find notes by frontmatter tag, or list all tags used across the vault. Use listAll: true to discover available tags.",
	inputSchema: vaultTagsSchema,
	execute: async ({ tags, listAll }, context) => {
		const readable = getReadableFolders(vaultMap(context));

		if (listAll) {
			const allTags = new Set<string>();
			for (const { absolutePath } of readable) {
				for await (const file of scanFiles(absolutePath, "**/*.md")) {
					try {
						const text = await readText(path.join(absolutePath, file));
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
			return "Provide tags to search for, or set listAll: true.";

		const searchTags = new Set(tags.map((t) => t.toLowerCase()));
		const results: string[] = [];
		for (const { absolutePath } of readable) {
			for await (const file of scanFiles(absolutePath, "**/*.md")) {
				try {
					const text = await readText(path.join(absolutePath, file));
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
};

// ─── links ───────────────────────────────────────────────────────────────────

const vaultLinksSchema = z.object({
	path: z
		.string({ error: "path must be the vault-relative note path to inspect." })
		.min(1, { error: "path must be the vault-relative note path to inspect." })
		.describe("Relative path to the note"),
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
};

// ─── outline ─────────────────────────────────────────────────────────────────

const vaultOutlineSchema = z.object({
	path: z
		.string({ error: "path must be the vault-relative note path to outline." })
		.min(1, { error: "path must be the vault-relative note path to outline." })
		.describe("Relative path to the note"),
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
};

// ─── toolset export ──────────────────────────────────────────────────────────

export const vaultToolset: ToolsetDefinition = {
	name: "vault",
	description:
		"Use when the request involves Jan's vault — his personal markdown note system for projects, ideas, journal entries, reference material, and second-brain content. The vault has multiple folders with different permission levels. Notes are memory, [[wikilinks]] are relationships, frontmatter tags enable discovery. Use for anything that sounds like a note, a document, something to remember, or something Jan would have written down. Prefer read-before-write: use vault_read or vault_outline before modifying notes to understand structure, language, and existing content.",
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
