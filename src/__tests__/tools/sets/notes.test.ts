import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point vault at a temp dir before importing tools
let tempDir: string;
let notesDir: string;

beforeAll(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "note-test-"));
	notesDir = join(tempDir, "Klaus", "notes");
	await mkdir(notesDir, { recursive: true });
	process.env.VAULT_DIR = tempDir;
});

afterAll(async () => {
	await rm(tempDir, { recursive: true, force: true });
	delete process.env.VAULT_DIR;
});

// Import after env is set
const { noteSearchTool, noteWriteTool, noteEditTool, noteDeleteTool } =
	await import("@/tools/sets/notes");

// Minimal context stub — note tools don't use TurnContext
const ctx = {} as Parameters<typeof noteWriteTool.execute>[1];

describe("notes.write", () => {
	test("creates a note with frontmatter when description provided", async () => {
		const result = await noteWriteTool.execute(
			{
				name: "test-topic",
				content: "Some knowledge",
				description: "A test note",
			},
			ctx,
		);
		expect(result).toBe("Written note: test-topic");

		const file = Bun.file(join(notesDir, "test-topic.md"));
		const text = await file.text();
		expect(text).toContain("description: A test note");
		expect(text).toContain("Some knowledge");
	});

	test("creates a note without frontmatter when no description", async () => {
		const result = await noteWriteTool.execute(
			{ name: "plain-note", content: "Just content" },
			ctx,
		);
		expect(result).toBe("Written note: plain-note");

		const text = await Bun.file(join(notesDir, "plain-note.md")).text();
		expect(text).toBe("Just content");
	});

	test("overwrites existing note", async () => {
		await noteWriteTool.execute({ name: "overwrite-me", content: "v1" }, ctx);
		await noteWriteTool.execute({ name: "overwrite-me", content: "v2" }, ctx);

		const text = await Bun.file(join(notesDir, "overwrite-me.md")).text();
		expect(text).toBe("v2");
	});

	test("rejects non-kebab-case names", async () => {
		const result = await noteWriteTool.execute(
			{ name: "Not Valid", content: "x" },
			ctx,
		);
		expect(result).toContain("Invalid name");
	});

	test("rejects names with path separators", async () => {
		const result = await noteWriteTool.execute(
			{ name: "sub/path", content: "x" },
			ctx,
		);
		expect(result).toContain("Invalid name");
	});
});

describe("notes.edit", () => {
	test("replaces matching text in an existing note", async () => {
		await noteWriteTool.execute(
			{ name: "edit-target", content: "Hello world, this is a test." },
			ctx,
		);

		const result = await noteEditTool.execute(
			{ name: "edit-target", old_string: "world", new_string: "universe" },
			ctx,
		);
		expect(result).toBe("Edited note: edit-target");

		const text = await Bun.file(join(notesDir, "edit-target.md")).text();
		expect(text).toBe("Hello universe, this is a test.");
	});

	test("returns error when old_string not found", async () => {
		await noteWriteTool.execute(
			{ name: "edit-miss", content: "Some content here" },
			ctx,
		);

		const result = await noteEditTool.execute(
			{ name: "edit-miss", old_string: "nonexistent", new_string: "replaced" },
			ctx,
		);
		expect(result).toContain("No match");
	});

	test("returns error for nonexistent note", async () => {
		const result = await noteEditTool.execute(
			{ name: "ghost-note", old_string: "x", new_string: "y" },
			ctx,
		);
		expect(result).toContain("not found");
	});

	test("rejects non-kebab-case names", async () => {
		const result = await noteEditTool.execute(
			{ name: "Bad Name", old_string: "x", new_string: "y" },
			ctx,
		);
		expect(result).toContain("Invalid name");
	});

	test("preserves frontmatter during edit", async () => {
		await noteWriteTool.execute(
			{
				name: "edit-fm",
				content: "Body text here",
				description: "A described note",
			},
			ctx,
		);

		await noteEditTool.execute(
			{
				name: "edit-fm",
				old_string: "Body text here",
				new_string: "Updated body",
			},
			ctx,
		);

		const text = await Bun.file(join(notesDir, "edit-fm.md")).text();
		expect(text).toContain("description: A described note");
		expect(text).toContain("Updated body");
		expect(text).not.toContain("Body text here");
	});
});

describe("notes.search", () => {
	test("matches by filename", async () => {
		await noteWriteTool.execute(
			{ name: "alpha-search", content: "unrelated body" },
			ctx,
		);

		const result = await noteSearchTool.execute(
			{ query: "alpha", limit: 10 },
			ctx,
		);
		expect(result).toContain("alpha-search");
		expect(result).toContain("unrelated body");
	});

	test("matches by body content", async () => {
		await noteWriteTool.execute(
			{ name: "hidden-gem", content: "the secret keyword here" },
			ctx,
		);

		const result = await noteSearchTool.execute(
			{ query: "secret keyword", limit: 10 },
			ctx,
		);
		expect(result).toContain("hidden-gem");
	});

	test("matches by frontmatter description", async () => {
		await noteWriteTool.execute(
			{ name: "described", content: "body", description: "unique-marker" },
			ctx,
		);

		const result = await noteSearchTool.execute(
			{ query: "unique-marker", limit: 10 },
			ctx,
		);
		expect(result).toContain("described");
	});

	test("returns no-match message for missing query", async () => {
		const result = await noteSearchTool.execute(
			{ query: "zzzznonexistent", limit: 10 },
			ctx,
		);
		expect(result).toContain("No notes matching");
	});

	test("respects limit", async () => {
		for (let i = 0; i < 5; i++) {
			await noteWriteTool.execute(
				{ name: `limited-${i}`, content: "same content" },
				ctx,
			);
		}

		const result = await noteSearchTool.execute(
			{ query: "limited", limit: 2 },
			ctx,
		);
		const matches = (result as string)
			.split("──")
			.filter((s) => s.includes("limited-"));
		expect(matches.length).toBeLessThanOrEqual(2);
	});

	test("returns message for empty query", async () => {
		const result = await noteSearchTool.execute(
			{ query: "   ", limit: 10 },
			ctx,
		);
		expect(result).toBe("Empty query.");
	});
});

describe("notes.delete", () => {
	test("deletes an existing note", async () => {
		await noteWriteTool.execute({ name: "to-delete", content: "bye" }, ctx);

		const result = await noteDeleteTool.execute(
			{ name: "to-delete", confirm: true },
			ctx,
		);
		expect(result).toBe("Deleted note: to-delete");

		const exists = await Bun.file(join(notesDir, "to-delete.md")).exists();
		expect(exists).toBe(false);
	});

	test("aborts without confirm", async () => {
		await noteWriteTool.execute({ name: "keep-me", content: "stay" }, ctx);

		const result = await noteDeleteTool.execute(
			{ name: "keep-me", confirm: false },
			ctx,
		);
		expect(result).toContain("aborted");

		const exists = await Bun.file(join(notesDir, "keep-me.md")).exists();
		expect(exists).toBe(true);
	});

	test("returns error for nonexistent note", async () => {
		const result = await noteDeleteTool.execute(
			{ name: "ghost", confirm: true },
			ctx,
		);
		expect(result).toContain("not found");
	});
});
