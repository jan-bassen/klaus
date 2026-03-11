import path from "path";
import { readdir, mkdir } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition, ToolsetDefinition } from "@/types";
import { config } from "@/config";

const vaultDir = () => config.vault.dir;

/** Guard against path traversal — resolved path must stay inside the vault. */
function safePath(relative: string): string | null {
  const resolved = path.resolve(vaultDir(), relative);
  return resolved.startsWith(vaultDir()) ? resolved : null;
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
  execute: async ({ path: rel }, _context) => {
    const full = safePath(rel);
    if (!full) return "Invalid path — must be inside the vault.";

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
  execute: async ({ query, limit }, _context) => {
    const glob = new Bun.Glob("**/*.md");
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return "Empty query.";

    const results: string[] = [];

    for await (const file of glob.scan({ cwd: vaultDir() })) {
      if (results.length >= limit) break;

      try {
        const text = await Bun.file(path.join(vaultDir(), file)).text();
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
  execute: async ({ directory, depth: rawDepth }, _context) => {
    const depth = Math.min(rawDepth, 5);
    const base = safePath(directory);
    if (!base) return "Invalid path — must be inside the vault.";

    const MAX_ENTRIES = 200;
    const lines: string[] = [];

    async function walk(
      dir: string,
      indent: number,
      remaining: number,
    ): Promise<number> {
      if (indent >= depth || remaining <= 0) return remaining;

      let entries;
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
    "Create or overwrite a note in the Obsidian vault. Parent directories are created automatically.",
  inputSchema: vaultWriteSchema,
  execute: async ({ path: rel, content }, _context) => {
    const full = safePath(rel);
    if (!full) return "Invalid path — must be inside the vault.";

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
});

export const vaultAppendTool: ToolDefinition<typeof vaultAppendSchema> = {
  name: "vault.append",
  description:
    "Append content to an existing note (useful for daily notes, logs, inboxes). Creates the file if it does not exist.",
  inputSchema: vaultAppendSchema,
  execute: async ({ path: rel, content }, _context) => {
    const full = safePath(rel);
    if (!full) return "Invalid path — must be inside the vault.";

    let existing = "";
    try {
      existing = await Bun.file(full).text();
    } catch {
      // File doesn't exist — will create it
      await mkdir(path.dirname(full), { recursive: true });
    }

    const newContent = existing ? `${existing}\n${content}` : content;
    await Bun.write(full, newContent);
    return `Appended to: ${rel}`;
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
  execute: async ({ noteName }, _context) => {
    const glob = new Bun.Glob("**/*.md");
    const pattern = new RegExp(
      `\\[\\[${noteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\|[^\\]]*)?\\]\\]`,
      "i",
    );
    const results: string[] = [];

    for await (const file of glob.scan({ cwd: vaultDir() })) {
      try {
        const text = await Bun.file(path.join(vaultDir(), file)).text();
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

// ─── toolset export ──────────────────────────────────────────────────────────

export const vaultToolset: ToolsetDefinition = {
  name: "vault",
  description:
    "Use when the request involves Jan's Obsidian vault — his personal markdown note system for projects, ideas, journal entries, reference material, and second-brain content. Distinct from memory (the knowledge graph DB) and files (arbitrary filesystem). Use this for anything that sounds like a note, a document, or something Jan would have written down.",
  tools: [
    vaultReadTool,
    vaultSearchTool,
    vaultListTool,
    vaultWriteTool,
    vaultAppendTool,
    vaultBacklinksTool,
  ],
};
