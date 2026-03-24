import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { log } from "@/logger";
import { settings } from "@/settings";
import type { ToolDefinition, ToolsetDefinition } from "@/types";

const notesDir = () => settings.vault.notesDir;

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Extract frontmatter description from note text. */
function parseDescription(text: string): string | undefined {
	const match = text.match(/^---\n[\s\S]*?description:\s*(.+)\n[\s\S]*?---/);
	return match?.[1]?.trim();
}

/** Strip frontmatter from note text. */
function stripFrontmatter(text: string): string {
	return text.replace(/^---\n[\s\S]*?---\n\n?/, "");
}

// ─── list ───────────────────────────────────────────────────────────────────

const noteListSchema = z.object({
	limit: z
		.number()
		.optional()
		.describe(
			`Max entries to return (default ${settings.vault.maxListEntries})`,
		),
});

export const noteListTool: ToolDefinition<typeof noteListSchema> = {
	name: "notes.list",
	description:
		"List all knowledge notes in Klaus/notes/ with their descriptions. Quick inventory of what the agent knows.",
	inputSchema: noteListSchema,
	execute: async ({ limit }) => {
		const max = limit ?? settings.vault.maxListEntries;
		const dir = notesDir();
		const glob = new Bun.Glob("*.md");
		const entries: string[] = [];

		for await (const file of glob.scan({ cwd: dir })) {
			const name = file.replace(/\.md$/, "");
			try {
				const text = await Bun.file(path.join(dir, file)).text();
				const desc = parseDescription(text);
				entries.push(desc ? `${name} — ${desc}` : name);
			} catch {
				entries.push(name);
			}
		}

		entries.sort((a, b) => a.localeCompare(b));
		const trimmed = entries.slice(0, max);

		return trimmed.length > 0 ? trimmed.join("\n") : "No notes found.";
	},
	kind: "builtin",
	capability: "resource",
};

// ─── read ───────────────────────────────────────────────────────────────────

const noteReadSchema = z.object({
	name: z
		.string()
		.describe(
			'Kebab-case note name without extension, e.g. "workout-preferences"',
		),
});

export const noteReadTool: ToolDefinition<typeof noteReadSchema> = {
	name: "notes.read",
	description: "Read the full content of a specific knowledge note by name.",
	inputSchema: noteReadSchema,
	execute: async ({ name }) => {
		if (!KEBAB_CASE.test(name)) {
			return `Invalid name "${name}" — must be kebab-case (e.g. "workout-preferences").`;
		}

		const filePath = path.join(notesDir(), `${name}.md`);
		try {
			return await Bun.file(filePath).text();
		} catch {
			return `Note not found: ${name}`;
		}
	},
	kind: "builtin",
	capability: "resource",
};

// ─── search ──────────────────────────────────────────────────────────────────

const noteSearchSchema = z.object({
	query: z
		.string()
		.describe("Search terms (case-insensitive substring match across notes)"),
	limit: z.number().optional().default(10).describe("Max results to return"),
});

export const noteSearchTool: ToolDefinition<typeof noteSearchSchema> = {
	name: "notes.search",
	description:
		"Search auto-managed knowledge notes in Klaus/notes/. Matches query against filenames, frontmatter description, and body. Returns compact results — use notes.read for full content.",
	inputSchema: noteSearchSchema,
	execute: async ({ query, limit }) => {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (terms.length === 0) return "Empty query.";

		const dir = notesDir();
		const glob = new Bun.Glob("*.md");
		const results: string[] = [];

		for await (const file of glob.scan({ cwd: dir })) {
			if (results.length >= limit) break;

			try {
				const text = await Bun.file(path.join(dir, file)).text();
				const name = file.replace(/\.md$/, "");
				const searchable = `${name}\n${text}`.toLowerCase();
				if (terms.every((t) => searchable.includes(t))) {
					const desc = parseDescription(text);
					const body = stripFrontmatter(text);
					const lines = body.split("\n").filter(Boolean);
					const matchLine = lines.find((l) =>
						terms.some((t) => l.toLowerCase().includes(t)),
					);
					const preview = matchLine
						? matchLine.length > 120
							? `${matchLine.slice(0, 117)}...`
							: matchLine
						: (lines[0]?.slice(0, 120) ?? "");
					const label = desc ? `${name} — ${desc}` : name;
					results.push(`${label}\n  ${preview}`);
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

// ─── write ───────────────────────────────────────────────────────────────────

const noteWriteSchema = z.object({
	name: z
		.string()
		.describe(
			'Kebab-case note name without extension, e.g. "workout-preferences"',
		),
	content: z.string().describe("Markdown content of the note"),
	description: z
		.string()
		.optional()
		.describe("One-line description (stored in frontmatter, aids search)"),
});

export const noteWriteTool: ToolDefinition<typeof noteWriteSchema> = {
	name: "notes.write",
	description:
		"Create or overwrite a knowledge note in Klaus/notes/. Use for auto-managed, topic-keyed knowledge that agents learn over time.",
	inputSchema: noteWriteSchema,
	execute: async ({ name, content, description }) => {
		if (!KEBAB_CASE.test(name)) {
			return `Invalid name "${name}" — must be kebab-case (e.g. "workout-preferences").`;
		}

		const dir = notesDir();
		await mkdir(dir, { recursive: true });

		let body: string;
		if (description) {
			body = `---\ndescription: ${description}\n---\n\n${content}`;
		} else {
			body = content;
		}

		const filePath = path.join(dir, `${name}.md`);
		await Bun.write(filePath, body);
		log.debug("[notes.write] written", { name });
		return `Written note: ${name}`;
	},
	kind: "builtin",
	capability: "tool",
};

// ─── edit ────────────────────────────────────────────────────────────────────

const noteEditSchema = z.object({
	name: z.string().describe("Kebab-case note name without extension"),
	old_string: z.string().describe("Exact text to find in the note"),
	new_string: z.string().describe("Replacement text"),
});

export const noteEditTool: ToolDefinition<typeof noteEditSchema> = {
	name: "notes.edit",
	description:
		"Find-and-replace within an existing knowledge note. More token-efficient than rewriting the whole note with notes.write.",
	inputSchema: noteEditSchema,
	execute: async ({ name, old_string, new_string }) => {
		if (!KEBAB_CASE.test(name)) {
			return `Invalid name "${name}" — must be kebab-case (e.g. "workout-preferences").`;
		}

		const filePath = path.join(notesDir(), `${name}.md`);
		let text: string;
		try {
			text = await Bun.file(filePath).text();
		} catch {
			return `Note not found: ${name}`;
		}

		if (!text.includes(old_string)) {
			return `No match for old_string in note "${name}".`;
		}

		const updated = text.replace(old_string, new_string);
		await Bun.write(filePath, updated);
		log.debug("[notes.edit] updated", { name });
		return `Edited note: ${name}`;
	},
	kind: "builtin",
	capability: "tool",
};

// ─── delete ──────────────────────────────────────────────────────────────────

const noteDeleteSchema = z.object({
	name: z.string().describe("Kebab-case note name without extension"),
	confirm: z
		.boolean()
		.describe(
			"Must be true to confirm deletion — prevents accidental data loss",
		),
});

export const noteDeleteTool: ToolDefinition<typeof noteDeleteSchema> = {
	name: "notes.delete",
	description:
		"Delete a knowledge note from Klaus/notes/. Requires confirm: true.",
	inputSchema: noteDeleteSchema,
	execute: async ({ name, confirm }) => {
		if (!confirm) return "Deletion aborted — set confirm: true to proceed.";

		const filePath = path.join(notesDir(), `${name}.md`);
		try {
			await unlink(filePath);
			log.debug("[notes.delete] removed", { name });
			return `Deleted note: ${name}`;
		} catch {
			return `Note not found or could not be deleted: ${name}`;
		}
	},
	kind: "builtin",
	capability: "tool",
};

// ─── toolset ─────────────────────────────────────────────────────────────────

export const noteToolset: ToolsetDefinition = {
	name: "notes",
	description:
		"Use when you need to list, read, search, write, edit, or delete auto-managed knowledge notes.",
	tools: [
		noteListTool,
		noteReadTool,
		noteSearchTool,
		noteWriteTool,
		noteEditTool,
		noteDeleteTool,
	],
};
