import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { settings } from "../../../infra/config.ts";
import { readText, scanFiles, writeData } from "../../../infra/runtime.ts";
import {
	checkPermission,
	getReadableFolders,
	isVaultPathReadable,
	type VaultOp,
} from "../../../infra/vault/index.ts";
import {
	extractFrontmatterTags,
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

// ─── shared helpers ──────────────────────────────────────────────────────────

interface VaultNote {
	vaultRel: string;
	absolutePath: string;
	text: string;
}

/**
 * Iterate every markdown note the current agent may read, optionally scoped to
 * a single directory. Unreadable files are skipped silently.
 */
async function* readableNotes(
	context: TurnContext,
	scopeAbs?: string,
): AsyncGenerator<VaultNote> {
	const access = vaultMap(context);
	const roots = scopeAbs
		? [{ absolutePath: scopeAbs }]
		: getReadableFolders(access);

	for (const { absolutePath: root } of roots) {
		for await (const file of scanFiles(root, "**/*.md")) {
			const absolutePath = path.join(root, file);
			const vaultRel = path.relative(vaultRoot(), absolutePath);
			if (!isVaultPathReadable(vaultRel, access)) continue;

			try {
				yield { vaultRel, absolutePath, text: await readText(absolutePath) };
			} catch {
				// Skip unreadable files
			}
		}
	}
}

function formatHeadingList(lines: string[]): string {
	const available = listHeadings(lines);
	return available.length > 0
		? available.map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n")
		: "(no headings)";
}

function headingNotFound(
	heading: string,
	rel: string,
	lines: string[],
): string {
	return `Heading "${heading}" not found in ${rel}. Available headings:\n${formatHeadingList(
		lines,
	)}`;
}

function buildOutline(lines: string[]): string {
	const headings = listHeadings(lines);

	if (headings.length === 0) {
		const nonEmpty = lines.filter((l) => l.trim().length > 0).length;
		return nonEmpty > 0 ? `(no headings, ${nonEmpty} lines)` : "(empty file)";
	}

	const outline: string[] = [];

	const topSection = findSection(lines, "");
	if (topSection) {
		const topLines = lines
			.slice(Math.max(topSection.headingIdx + 1, 0), topSection.endIdx)
			.filter((l) => l.trim().length > 0).length;
		if (topLines > 0) {
			outline.push(
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
		outline.push(
			`${prefix} ${h.text} (${contentLines} ${contentLines === 1 ? "item" : "items"})`,
		);
	}

	return outline.join("\n");
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
	section: z
		.string()
		.optional()
		.describe(
			'Optional heading: return only that section. Use exact heading text without # markers, or "" for the top-level content before the first heading.',
		),
	view: z
		.enum(["full", "outline"])
		.optional()
		.default("full")
		.describe(
			'"full" returns note content; "outline" returns only the heading structure with per-section item counts (cheap way to see a note\'s shape).',
		),
});

export const vaultReadTool: ToolDefinition<typeof vaultReadSchema> = {
	name: "vault_read",
	description:
		'Read a note from the vault. Returns full markdown including frontmatter by default. Set section to read just one section, or view: "outline" to see the heading structure without the content — useful before editing a large note.',
	inputSchema: vaultReadSchema,
	execute: async ({ path: rel, section, view }, context) => {
		const note = await readVaultNote(rel, "read", context);
		if (typeof note === "string") return note;

		if (view === "outline") return buildOutline(note.text.split("\n"));

		if (section === undefined) return note.text;

		const lines = note.text.split("\n");
		const found = findSection(lines, section);
		if (!found) return headingNotFound(section, rel, lines);

		const start = Math.max(found.headingIdx, 0);
		const body = lines.slice(start, found.endIdx).join("\n").trim();
		return body || "(empty section)";
	},
};

// ─── find ────────────────────────────────────────────────────────────────────

const vaultFindSchema = z.object({
	query: z
		.string()
		.optional()
		.describe(
			"Full-text filter: case-insensitive, all words must appear in the note",
		),
	tag: z
		.string()
		.optional()
		.describe('Frontmatter tag filter, e.g. "recipe" (without #)'),
	linksTo: z
		.string()
		.optional()
		.describe(
			'Backlink filter: only notes containing a [[wikilink]] to this note title (without .md), e.g. "Klaus"',
		),
	in: z
		.string()
		.optional()
		.describe('Optional folder to search within, e.g. "Projects"'),
	limit: z
		.number({ error: "limit must be a whole number." })
		.int({ error: "limit must be a whole number." })
		.min(1, { error: "limit must be at least 1." })
		.optional()
		.default(10)
		.describe("Max results to return"),
});

const MAX_PREVIEW_LINES = 3;

export const vaultFindTool: ToolDefinition<typeof vaultFindSchema> = {
	name: "vault_find",
	description:
		"Find notes across the vault. Filters combine (AND): query for full-text search, tag for frontmatter tags, linksTo for backlinks to a note. Returns matching paths with preview lines. Provide at least one filter.",
	inputSchema: vaultFindSchema,
	execute: async ({ query, tag, linksTo, in: scope, limit }, context) => {
		const terms = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
		const wantTag = tag?.toLowerCase();
		const linkPattern = linksTo ? wikilinkTargetPattern(linksTo) : undefined;

		if (terms.length === 0 && !wantTag && !linkPattern) {
			return "Provide at least one filter: query, tag, or linksTo.";
		}

		let scopeAbs: string | undefined;
		if (scope) {
			const result = await gateVaultTool(scope, "read", context);
			if (typeof result === "object") return result.error;
			scopeAbs = result;
		}

		const results: string[] = [];
		const seenTags = new Set<string>();

		for await (const note of readableNotes(context, scopeAbs)) {
			if (results.length >= limit) break;

			if (wantTag) {
				const noteTags = extractFrontmatterTags(note.text).map((t) =>
					t.toLowerCase(),
				);
				for (const t of noteTags) seenTags.add(t);
				if (!noteTags.includes(wantTag)) continue;
			}

			if (linkPattern && !linkPattern.test(note.text)) continue;

			const lower = note.text.toLowerCase();
			if (terms.length > 0 && !terms.every((t) => lower.includes(t))) continue;

			const lines = note.text.split("\n");
			const previews = lines
				.filter((l) => {
					const ll = l.toLowerCase();
					return (
						(terms.length > 0 && terms.some((t) => ll.includes(t))) ||
						(linkPattern?.test(l) ?? false)
					);
				})
				.slice(0, MAX_PREVIEW_LINES)
				.map((l) => `  ${l.trim().slice(0, 120)}`);

			results.push([note.vaultRel, ...previews].join("\n"));
		}

		if (results.length > 0) return results.join("\n");

		const filters = [
			terms.length > 0 ? `query "${query}"` : null,
			wantTag ? `tag "${tag}"` : null,
			linksTo ? `linksTo "${linksTo}"` : null,
		]
			.filter(Boolean)
			.join(", ");
		let msg = `No notes matching ${filters}.`;
		if (wantTag && seenTags.size > 0) {
			msg += ` Tags in use: ${[...seenTags].sort().join(", ")}`;
		}
		return msg;
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
			const access = vaultMap(context);
			const readable = getReadableFolders(access);
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
					access,
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
		await walkVaultDir(result, depth, MAX_ENTRIES, lines, 0, vaultMap(context));
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
		"Create or overwrite a note in the vault. Parent directories are created automatically. Overwrites the entire file — for changes to an existing note prefer vault_edit, or read first with vault_read.",
	inputSchema: vaultWriteSchema,
	execute: async ({ path: rel, content }, context) => {
		const result = await gateVaultTool(rel, "full", context);
		if (typeof result === "object") return result.error;

		await mkdir(path.dirname(result), { recursive: true });
		await writeData(result, content);
		return `Written: ${rel}`;
	},
};

// ─── edit ────────────────────────────────────────────────────────────────────

const vaultEditSchema = z.object({
	path: z
		.string({ error: "path must be the vault-relative note path to edit." })
		.min(1, { error: "path must be the vault-relative note path to edit." })
		.describe("Relative path to the note to edit"),
	mode: z
		.enum(["append", "replace"])
		.describe(
			'"append" adds content inside a section (or at end of file when no heading is given); "replace" overwrites a section body (heading required)',
		),
	content: z
		.string({ error: "content must be the markdown to apply." })
		.min(1, { error: "content must be the markdown to apply." })
		.describe("Markdown content to append, or the replacement section body"),
	heading: z
		.string()
		.optional()
		.describe(
			'Target section: exact heading text without # markers, or "" for the top-level content before the first heading. Omit (append mode only) to append at end of file. Use vault_read with view: "outline" to see available sections.',
		),
});

export const vaultEditTool: ToolDefinition<typeof vaultEditSchema> = {
	name: "vault_edit",
	description:
		"Edit an existing note section-by-section: append content into a section (or end of file), or replace a section's body while keeping the heading line. Creates the file when appending to a missing one. Prefer this over vault_write for targeted changes.",
	inputSchema: vaultEditSchema,
	execute: async ({ path: rel, mode, content, heading }, context) => {
		if (mode === "replace" && heading === undefined) {
			return 'replace mode requires a heading ("" targets the top-level section).';
		}

		const op: VaultOp = mode === "append" ? "append" : "full";
		const result = await gateVaultTool(rel, op, context);
		if (typeof result === "object") return result.error;

		let existing = "";
		let exists = true;
		try {
			existing = await readText(result);
		} catch {
			exists = false;
		}

		if (!exists) {
			if (mode === "replace") return `Note not found: ${rel}`;
			await mkdir(path.dirname(result), { recursive: true });
			await writeData(result, content);
			return `Appended to: ${rel}`;
		}

		// Append at end of file
		if (mode === "append" && heading === undefined) {
			await writeData(result, `${existing}\n${content}`);
			return `Appended to: ${rel}`;
		}

		const lines = existing.split("\n");
		const section = findSection(lines, heading ?? "");
		if (!section) return headingNotFound(heading ?? "", rel, lines);

		const sectionName = heading === "" ? "(top-level)" : `"${heading}"`;

		if (mode === "append") {
			const updated = [
				...lines.slice(0, section.endIdx),
				content,
				...lines.slice(section.endIdx),
			].join("\n");
			await writeData(result, updated);
			return `Appended to section ${sectionName} in: ${rel}`;
		}

		const updated = [
			...lines.slice(0, section.headingIdx + 1),
			content,
			...lines.slice(section.endIdx),
		].join("\n");
		await writeData(result, updated);
		return `Replaced section ${sectionName} in: ${rel}`;
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
		const access = vaultMap(context);

		for await (const note of readableNotes(context)) {
			const updated = note.text.replace(pattern, `[[${newName}$1]]`);
			if (updated === note.text) continue;

			if (checkPermission(note.vaultRel, "full", access) === "allowed") {
				await writeData(note.absolutePath, updated);
				updatedCount++;
			} else {
				skipped.push(note.vaultRel);
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

// ─── toolset export ──────────────────────────────────────────────────────────

export const vaultToolset: ToolsetDefinition = {
	name: "vault",
	description:
		'Use when the request involves Jan\'s vault — his personal markdown note system for projects, ideas, journal entries, reference material, and second-brain content. Agent vault access is path-scoped, so some notes or folders may be unreadable or read-only. Notes are memory, [[wikilinks]] are relationships, frontmatter tags enable discovery. Use for anything that sounds like a note, a document, something to remember, or something Jan would have written down. Prefer read-before-write: use vault_read (optionally with view: "outline") before modifying notes to understand structure, language, and existing content.',
	tools: [
		vaultReadTool,
		vaultFindTool,
		vaultListTool,
		vaultWriteTool,
		vaultEditTool,
		vaultMoveTool,
		vaultDeleteTool,
	],
};
