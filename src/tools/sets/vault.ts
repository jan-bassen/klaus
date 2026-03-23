import type { Dirent } from "node:fs";
import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { settings } from "@/settings";
import type { ToolDefinition, ToolsetDefinition } from "@/types";

const vaultDir = () => settings.vault.dir;

/** Guard against path traversal and optional agent scope restriction. */
function safePath(relative: string, scope?: string): string | null {
	const resolved = path.resolve(vaultDir(), relative);
	if (!resolved.startsWith(vaultDir())) return null;
	if (scope) {
		const scopeDir = path.resolve(vaultDir(), scope);
		if (resolved !== scopeDir && !resolved.startsWith(scopeDir + path.sep))
			return null;
	}
	return resolved;
}

function scopeError(scope?: string): string {
	return scope
		? `Access denied — path must be inside vault scope: ${scope}`
		: "Invalid path — must be inside the vault.";
}

// ─── read ────────────────────────────────────────────────────────────────────

const vaultReadSchema = z.object({
	path: z
		.string()
		.describe('Relative path to the note, e.g. "Projects/Klaus.md"'),
});

export const vaultReadTool: ToolDefinition<typeof vaultReadSchema> = {
	name: "vault.read",
	description:
		"Read a note from the Obsidian vault by its relative path. Returns the full markdown content including frontmatter.",
	inputSchema: vaultReadSchema,
	execute: async ({ path: rel }, context) => {
		const full = safePath(rel, context.agent.vaultScope);
		if (!full) return scopeError(context.agent.vaultScope);

		try {
			return await Bun.file(full).text();
		} catch {
			return `Note not found: ${rel}`;
		}
	},
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
	name: "vault.search",
	description:
		"Full-text search across all markdown notes in the Obsidian vault. Returns matching file paths with context lines.",
	inputSchema: vaultSearchSchema,
	execute: async ({ query, limit }, context) => {
		const glob = new Bun.Glob("**/*.md");
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (terms.length === 0) return "Empty query.";

		const scanRoot = context.agent.vaultScope
			? path.resolve(vaultDir(), context.agent.vaultScope)
			: vaultDir();
		const results: string[] = [];

		for await (const file of glob.scan({ cwd: scanRoot })) {
			if (results.length >= limit) break;

			try {
				const text = await Bun.file(path.join(scanRoot, file)).text();
				const lower = text.toLowerCase();
				if (terms.every((t) => lower.includes(t))) {
					// Find first matching line for context
					const lines = text.split("\n");
					const matchLine = lines.find((l) => {
						const ll = l.toLowerCase();
						return terms.some((t) => ll.includes(t));
					});
					const preview = matchLine?.trim().slice(0, 120) ?? "";
					results.push(`${file}${preview ? ` — ${preview}` : ""}`);
				}
			} catch {
				// Skip unreadable files
			}
		}

		return results.length > 0
			? results.join("\n")
			: `No notes matching "${query}".`;
	},
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
	name: "vault.list",
	description:
		"Browse the directory structure of the Obsidian vault. Returns a tree of folders and .md files.",
	inputSchema: vaultListSchema,
	execute: async ({ directory, depth: rawDepth }, context) => {
		const depth = Math.min(rawDepth, 5);
		const effectiveDir = directory || context.agent.vaultScope || "";
		const base = safePath(effectiveDir, context.agent.vaultScope);
		if (!base) return scopeError(context.agent.vaultScope);

		const MAX_ENTRIES = 200;
		const lines: string[] = [];

		async function walk(
			dir: string,
			indent: number,
			remaining: number,
		): Promise<number> {
			if (indent >= depth || remaining <= 0) return remaining;

			let entries: Dirent[];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return remaining;
			}

			// Sort: directories first, then files, alphabetically
			entries.sort((a, b) => {
				if (a.isDirectory() !== b.isDirectory())
					return a.isDirectory() ? -1 : 1;
				return a.name.localeCompare(b.name);
			});

			for (const entry of entries) {
				if (remaining <= 0) break;
				// Skip hidden files/directories
				if (entry.name.startsWith(".")) continue;

				const prefix = "  ".repeat(indent);
				if (entry.isDirectory()) {
					lines.push(`${prefix}${entry.name}/`);
					remaining--;
					remaining = await walk(
						path.join(dir, entry.name),
						indent + 1,
						remaining,
					);
				} else if (entry.name.endsWith(".md")) {
					lines.push(`${prefix}${entry.name}`);
					remaining--;
				}
			}
			return remaining;
		}

		await walk(base, 0, MAX_ENTRIES);
		return lines.length > 0 ? lines.join("\n") : "Empty directory.";
	},
	kind: "builtin",
	capability: "resource",
};

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
		// Top-level section: content before the first heading
		let startIdx = 0;
		// Skip frontmatter
		if (lines[0]?.trimEnd() === "---") {
			for (let i = 1; i < lines.length; i++) {
				if ((lines[i] ?? "").trimEnd() === "---") {
					startIdx = i + 1;
					break;
				}
			}
		}
		// Find first heading
		let firstHeading = lines.length;
		for (let i = startIdx; i < lines.length; i++) {
			if (/^#{1,6}\s/.test(lines[i] ?? "")) {
				firstHeading = i;
				break;
			}
		}
		return { headingIdx: -1, level: 0, endIdx: firstHeading };
	}

	// Named heading
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
	name: "vault.write",
	description:
		"Create or overwrite a note in the Obsidian vault. Parent directories are created automatically. OVERWRITES the entire file — read first with vault.read if you need to preserve existing content.",
	inputSchema: vaultWriteSchema,
	execute: async ({ path: rel, content }, context) => {
		const full = safePath(rel, context.agent.vaultScope);
		if (!full) return scopeError(context.agent.vaultScope);

		await mkdir(path.dirname(full), { recursive: true });
		await Bun.write(full, content);
		return `Written: ${rel}`;
	},
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
	name: "vault.append",
	description:
		"Append content to an existing note (useful for daily notes, logs, inboxes). Creates the file if it does not exist. For structured notes with sections, set the heading parameter to append inside a specific section — use vault.outline first to see available sections.",
	inputSchema: vaultAppendSchema,
	execute: async ({ path: rel, content, heading }, context) => {
		const full = safePath(rel, context.agent.vaultScope);
		if (!full) return scopeError(context.agent.vaultScope);

		let existing = "";
		try {
			existing = await Bun.file(full).text();
		} catch {
			// File doesn't exist — will create it
			await mkdir(path.dirname(full), { recursive: true });
		}

		// No heading specified → append to EOF (original behavior)
		if (heading === undefined) {
			const newContent = existing ? `${existing}\n${content}` : content;
			await Bun.write(full, newContent);
			return `Appended to: ${rel}`;
		}

		// Heading specified but file is empty/new → just write content
		if (!existing) {
			await Bun.write(full, content);
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

		// Insert content at end of section (before next heading / EOF)
		const before = lines.slice(0, section.endIdx);
		const after = lines.slice(section.endIdx);
		const updated = [...before, content, ...after].join("\n");
		await Bun.write(full, updated);
		return `Appended to section ${heading === "" ? "(top-level)" : `"${heading}"`} in: ${rel}`;
	},
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
	name: "vault.backlinks",
	description:
		"Find all notes that link to a given note via [[wikilinks]]. Returns file paths with the linking line.",
	inputSchema: vaultBacklinksSchema,
	execute: async ({ noteName }, context) => {
		const glob = new Bun.Glob("**/*.md");
		const pattern = new RegExp(
			`\\[\\[${noteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\|[^\\]]*)?\\]\\]`,
			"i",
		);
		const scanRoot = context.agent.vaultScope
			? path.resolve(vaultDir(), context.agent.vaultScope)
			: vaultDir();
		const results: string[] = [];

		for await (const file of glob.scan({ cwd: scanRoot })) {
			try {
				const text = await Bun.file(path.join(scanRoot, file)).text();
				const lines = text.split("\n");
				const match = lines.find((l) => pattern.test(l));
				if (match) {
					results.push(`${file} — ${match.trim().slice(0, 120)}`);
				}
			} catch {
				// Skip unreadable files
			}
		}

		return results.length > 0
			? results.join("\n")
			: `No backlinks found for "${noteName}".`;
	},
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
	name: "vault.move",
	description:
		"Move or rename a note within the vault. Optionally updates all [[wikilinks]] across the vault that referenced the old name.",
	inputSchema: vaultMoveSchema,
	execute: async ({ from, to, updateBacklinks }, context) => {
		const srcFull = safePath(from, context.agent.vaultScope);
		const dstFull = safePath(to, context.agent.vaultScope);
		if (!srcFull)
			return context.agent.vaultScope
				? `Access denied — source path must be inside vault scope: ${context.agent.vaultScope}`
				: "Invalid source path — must be inside the vault.";
		if (!dstFull)
			return context.agent.vaultScope
				? `Access denied — destination path must be inside vault scope: ${context.agent.vaultScope}`
				: "Invalid destination path — must be inside the vault.";

		try {
			await mkdir(path.dirname(dstFull), { recursive: true });
			await rename(srcFull, dstFull);
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
		for await (const file of glob.scan({ cwd: vaultDir() })) {
			const filePath = path.join(vaultDir(), file);
			try {
				const text = await Bun.file(filePath).text();
				const updated = text.replace(pattern, `[[${newName}$1]]`);
				if (updated !== text) {
					await Bun.write(filePath, updated);
					updatedCount++;
				}
			} catch {
				// Skip unreadable files
			}
		}

		return `Moved: ${from} → ${to}. Updated backlinks in ${updatedCount} note(s).`;
	},
	kind: "builtin",
	capability: "tool",
};

// ─── delete ──────────────────────────────────────────────────────────────────

const vaultDeleteSchema = z.object({
	path: z.string().describe("Relative path to the note to delete"),
	confirm: z
		.boolean()
		.describe(
			"Must be true to confirm deletion — prevents accidental data loss",
		),
});

export const vaultDeleteTool: ToolDefinition<typeof vaultDeleteSchema> = {
	name: "vault.delete",
	description:
		"Permanently delete a note from the vault. Requires confirm: true to prevent accidents.",
	inputSchema: vaultDeleteSchema,
	execute: async ({ path: rel, confirm }, context) => {
		if (!confirm) return "Deletion aborted — set confirm: true to proceed.";

		const full = safePath(rel, context.agent.vaultScope);
		if (!full) return scopeError(context.agent.vaultScope);

		try {
			await unlink(full);
			return `Deleted: ${rel}`;
		} catch {
			return `Note not found or could not be deleted: ${rel}`;
		}
	},
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
	name: "vault.patch",
	description:
		"Replace the body of a specific section in a note by heading. The heading line is kept; everything beneath it until the next same-or-higher-level heading (or EOF) is replaced. Read the note first with vault.read to see current content before replacing.",
	inputSchema: vaultPatchSchema,
	execute: async ({ path: rel, heading, newContent }, context) => {
		const full = safePath(rel, context.agent.vaultScope);
		if (!full) return scopeError(context.agent.vaultScope);

		let text: string;
		try {
			text = await Bun.file(full).text();
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
		await Bun.write(full, updated);
		return `Patched section "${heading}" in ${rel}.`;
	},
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
	name: "vault.tags",
	description:
		"Find notes by frontmatter tag, or list all tags used across the vault. Use list: true to discover available tags.",
	inputSchema: vaultTagsSchema,
	execute: async ({ tags, list }, context) => {
		const glob = new Bun.Glob("**/*.md");
		const scanRoot = context.agent.vaultScope
			? path.resolve(vaultDir(), context.agent.vaultScope)
			: vaultDir();
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
			for await (const file of glob.scan({ cwd: scanRoot })) {
				try {
					const text = await Bun.file(path.join(scanRoot, file)).text();
					for (const t of extractTags(text)) allTags.add(t);
				} catch {
					// Skip unreadable files
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
		for await (const file of glob.scan({ cwd: scanRoot })) {
			try {
				const text = await Bun.file(path.join(scanRoot, file)).text();
				const noteTags = extractTags(text).map((t) => t.toLowerCase());
				if (noteTags.some((t) => searchTags.has(t))) results.push(file);
			} catch {
				// Skip unreadable files
			}
		}

		return results.length > 0
			? results.join("\n")
			: `No notes tagged with: ${tags.join(", ")}.`;
	},
	kind: "builtin",
	capability: "resource",
};

// ─── links ───────────────────────────────────────────────────────────────────

const vaultLinksSchema = z.object({
	path: z.string().describe("Relative path to the note"),
});

export const vaultLinksTool: ToolDefinition<typeof vaultLinksSchema> = {
	name: "vault.links",
	description:
		"Extract all outgoing [[wikilinks]] from a note. Complements vault.backlinks for graph traversal.",
	inputSchema: vaultLinksSchema,
	execute: async ({ path: rel }, context) => {
		const full = safePath(rel, context.agent.vaultScope);
		if (!full) return scopeError(context.agent.vaultScope);

		let text: string;
		try {
			text = await Bun.file(full).text();
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
	kind: "builtin",
	capability: "resource",
};

// ─── outline ─────────────────────────────────────────────────────────────────

const vaultOutlineSchema = z.object({
	path: z.string().describe("Relative path to the note"),
});

export const vaultOutlineTool: ToolDefinition<typeof vaultOutlineSchema> = {
	name: "vault.outline",
	description:
		"Return the heading structure of a note with item counts per section. Use before vault.append or vault.patch to see available sections without reading the full note.",
	inputSchema: vaultOutlineSchema,
	execute: async ({ path: rel }, context) => {
		const full = safePath(rel, context.agent.vaultScope);
		if (!full) return scopeError(context.agent.vaultScope);

		let text: string;
		try {
			text = await Bun.file(full).text();
		} catch {
			return `Note not found: ${rel}`;
		}

		const lines = text.split("\n");
		const headings = listHeadings(lines);

		if (headings.length === 0) {
			const nonEmpty = lines.filter((l) => l.trim().length > 0).length;
			return nonEmpty > 0 ? `(no headings, ${nonEmpty} lines)` : "(empty file)";
		}

		const result: string[] = [];

		// Top-level content (before first heading, after frontmatter)
		const topSection = findSection(lines, "");
		if (topSection) {
			const topLines = lines
				.slice(Math.max(topSection.headingIdx + 1, 0), topSection.endIdx)
				.filter((l) => l.trim().length > 0).length;
			if (topLines > 0) {
				result.push(
					`(top-level: ${topLines} ${topLines === 1 ? "line" : "lines"})`,
				);
			}
		}

		// Each heading section
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
			result.push(
				`${prefix} ${h.text} (${contentLines} ${contentLines === 1 ? "item" : "items"})`,
			);
		}

		return result.join("\n");
	},
	kind: "builtin",
	capability: "resource",
};

// ─── toolset export ──────────────────────────────────────────────────────────

export const vaultToolset: ToolsetDefinition = {
	name: "vault",
	description:
		"Use when the request involves Jan's Obsidian vault — his personal markdown note system for projects, ideas, journal entries, reference material, and second-brain content. This is the primary knowledge interface: notes are memory, [[wikilinks]] are relationships, frontmatter tags enable discovery. Klaus's memory lives in Klaus/memory.md and user profile in Klaus/user.md. Use for anything that sounds like a note, a document, something to remember, or something Jan would have written down. Prefer read-before-write: use vault.read or vault.outline before modifying notes to understand structure, language, and existing content.",
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
