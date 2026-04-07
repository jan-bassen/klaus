import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock settings before importing vault tools
mock.module("@/settings", () => ({
	settings: {
		vault: {
			root: "",
			internal: "Klaus",
			folders: [{ path: "", default: "full" }],
			internalPermission: { default: "read", request: "full" },
			get internalPath() {
				return join(this.root, this.internal);
			},
			maxListEntries: 200,
		},
	},
}));

// Mock awaitConfirmation to auto-confirm (tests don't have WhatsApp context)
mock.module("@/whatsapp/confirm", () => ({
	awaitConfirmation: async () => "confirmed" as const,
}));

import { settings } from "@/settings";
import {
	findSection,
	listHeadings,
	vaultAppendTool,
	vaultOutlineTool,
	vaultPatchTool,
} from "@/tools/sets/vault";
import type { AgentDefinition, TurnContext } from "@/types";

let tmpDir: string;

function setVaultDir(dir: string): void {
	(settings.vault as { root: string }).root = dir;
}

function makeContext(vaultScope?: string): TurnContext {
	return {
		agent: { vaultScope } as AgentDefinition,
	} as TurnContext;
}

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "vault-test-"));
	setVaultDir(tmpDir);
});

afterAll(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

// ─── findSection ─────────────────────────────────────────────────────────────

describe("findSection", () => {
	test("finds a named heading and its bounds", () => {
		const lines = [
			"# Title",
			"intro",
			"## Goals",
			"- goal 1",
			"- goal 2",
			"## Notes",
			"some notes",
		];
		const result = findSection(lines, "Goals");
		expect(result).toEqual({ headingIdx: 2, level: 2, endIdx: 5 });
	});

	test("returns null when heading not found", () => {
		const lines = ["# Title", "## Goals", "- goal 1"];
		expect(findSection(lines, "Missing")).toBeNull();
	});

	test("last section extends to end of file", () => {
		const lines = ["# Title", "## Goals", "- goal 1", "- goal 2"];
		const result = findSection(lines, "Goals");
		expect(result).toEqual({ headingIdx: 1, level: 2, endIdx: 4 });
	});

	test("is case-insensitive", () => {
		const lines = ["## Lebensmittel", "- Milch"];
		const result = findSection(lines, "lebensmittel");
		expect(result).toEqual({ headingIdx: 0, level: 2, endIdx: 2 });
	});

	test("handles special regex characters in heading", () => {
		const lines = ["## Goals (2024)", "- goal"];
		const result = findSection(lines, "Goals (2024)");
		expect(result).toEqual({ headingIdx: 0, level: 2, endIdx: 2 });
	});

	test("top-level section (empty heading) returns content before first heading", () => {
		const lines = ["some intro", "another line", "## Section", "content"];
		const result = findSection(lines, "");
		expect(result).toEqual({ headingIdx: -1, level: 0, endIdx: 2 });
	});

	test("top-level section skips frontmatter", () => {
		const lines = [
			"---",
			"title: Test",
			"---",
			"intro text",
			"## Section",
			"content",
		];
		const result = findSection(lines, "");
		expect(result).toEqual({ headingIdx: -1, level: 0, endIdx: 4 });
	});

	test("top-level section with no headings returns entire file length", () => {
		const lines = ["just", "plain", "text"];
		const result = findSection(lines, "");
		expect(result).toEqual({ headingIdx: -1, level: 0, endIdx: 3 });
	});

	test("top-level section with frontmatter and no headings", () => {
		const lines = ["---", "tags: [test]", "---", "content here"];
		const result = findSection(lines, "");
		expect(result).toEqual({ headingIdx: -1, level: 0, endIdx: 4 });
	});

	test("same-level heading ends section, higher-level does too", () => {
		const lines = [
			"# Title",
			"## A",
			"content a",
			"# Another Title",
			"## B",
			"content b",
		];
		const result = findSection(lines, "A");
		expect(result).toEqual({ headingIdx: 1, level: 2, endIdx: 3 });
	});

	test("lower-level heading does not end section", () => {
		const lines = [
			"## Parent",
			"content",
			"### Child",
			"child content",
			"## Next",
		];
		const result = findSection(lines, "Parent");
		expect(result).toEqual({ headingIdx: 0, level: 2, endIdx: 4 });
	});
});

// ─── listHeadings ────────────────────────────────────────────────────────────

describe("listHeadings", () => {
	test("lists all headings with levels", () => {
		const lines = ["# Title", "text", "## A", "### B", "## C"];
		const result = listHeadings(lines);
		expect(result).toEqual([
			{ text: "Title", level: 1, lineIdx: 0 },
			{ text: "A", level: 2, lineIdx: 2 },
			{ text: "B", level: 3, lineIdx: 3 },
			{ text: "C", level: 2, lineIdx: 4 },
		]);
	});

	test("returns empty array for no headings", () => {
		expect(listHeadings(["just text", "more text"])).toEqual([]);
	});
});

// ─── vault.append with heading ───────────────────────────────────────────────

describe("vault.append with heading", () => {
	test("appends to EOF when heading is omitted (backward compat)", async () => {
		const file = join(tmpDir, "eof-test.md");
		await Bun.write(file, "line 1\nline 2");
		const result = await vaultAppendTool.execute(
			{ path: "eof-test.md", content: "line 3" },
			makeContext(),
		);
		expect(result).toContain("Appended to");
		const content = await Bun.file(file).text();
		expect(content).toBe("line 1\nline 2\nline 3");
	});

	test("appends inside a mid-file section", async () => {
		const file = join(tmpDir, "mid-section.md");
		await Bun.write(
			file,
			"# Einkaufsliste\n## Lebensmittel\n- Brot\n- Käse\n## Baumarkt\n- Schrauben",
		);
		const result = await vaultAppendTool.execute(
			{ path: "mid-section.md", content: "- Milch", heading: "Lebensmittel" },
			makeContext(),
		);
		expect(result).toContain('section "Lebensmittel"');
		const content = await Bun.file(file).text();
		expect(content).toBe(
			"# Einkaufsliste\n## Lebensmittel\n- Brot\n- Käse\n- Milch\n## Baumarkt\n- Schrauben",
		);
	});

	test("appends inside the last section", async () => {
		const file = join(tmpDir, "last-section.md");
		await Bun.write(file, "## A\n- item 1\n## B\n- item 2");
		const result = await vaultAppendTool.execute(
			{ path: "last-section.md", content: "- item 3", heading: "B" },
			makeContext(),
		);
		expect(result).toContain('section "B"');
		const content = await Bun.file(file).text();
		expect(content).toBe("## A\n- item 1\n## B\n- item 2\n- item 3");
	});

	test("appends inside top-level section (empty heading)", async () => {
		const file = join(tmpDir, "top-level.md");
		await Bun.write(file, "intro\n## Section\ncontent");
		const result = await vaultAppendTool.execute(
			{ path: "top-level.md", content: "extra intro", heading: "" },
			makeContext(),
		);
		expect(result).toContain("(top-level)");
		const content = await Bun.file(file).text();
		expect(content).toBe("intro\nextra intro\n## Section\ncontent");
	});

	test("returns error with available headings when heading not found", async () => {
		const file = join(tmpDir, "not-found.md");
		await Bun.write(file, "## Alpha\ncontent\n## Beta\ncontent");
		const result = await vaultAppendTool.execute(
			{ path: "not-found.md", content: "stuff", heading: "Gamma" },
			makeContext(),
		);
		expect(result).toContain('Heading "Gamma" not found');
		expect(result).toContain("## Alpha");
		expect(result).toContain("## Beta");
	});

	test("creates file when it does not exist (no heading)", async () => {
		const result = await vaultAppendTool.execute(
			{ path: "new-file.md", content: "hello" },
			makeContext(),
		);
		expect(result).toContain("Appended to");
		const content = await Bun.file(join(tmpDir, "new-file.md")).text();
		expect(content).toBe("hello");
	});
});

// ─── vault.outline ───────────────────────────────────────────────────────────

describe("vault.outline", () => {
	test("returns heading structure with item counts", async () => {
		const file = join(tmpDir, "outline-test.md");
		await Bun.write(
			file,
			"intro\n## Lebensmittel\n- Brot\n- Käse\n- Milch\n- Butter\n- Eier\n## Baumarkt\n- Schrauben\n- Dübel\n- Nägel\n## IKEA",
		);
		const result = await vaultOutlineTool.execute(
			{ path: "outline-test.md" },
			makeContext(),
		);
		expect(result).toContain("(top-level: 1 line)");
		expect(result).toContain("## Lebensmittel (5 items)");
		expect(result).toContain("## Baumarkt (3 items)");
		expect(result).toContain("## IKEA (0 items)");
	});

	test("handles empty file", async () => {
		const file = join(tmpDir, "empty-outline.md");
		await Bun.write(file, "");
		const result = await vaultOutlineTool.execute(
			{ path: "empty-outline.md" },
			makeContext(),
		);
		expect(result).toBe("(empty file)");
	});

	test("handles file with no headings", async () => {
		const file = join(tmpDir, "no-headings.md");
		await Bun.write(file, "just some text\nmore text");
		const result = await vaultOutlineTool.execute(
			{ path: "no-headings.md" },
			makeContext(),
		);
		expect(result).toContain("no headings, 2 lines");
	});

	test("handles file not found", async () => {
		const result = await vaultOutlineTool.execute(
			{ path: "nonexistent.md" },
			makeContext(),
		);
		expect(result).toContain("Note not found");
	});

	test("respects vault scope", async () => {
		const result = await vaultOutlineTool.execute(
			{ path: "../outside.md" },
			makeContext("Scoped"),
		);
		expect(result).toContain("Access denied");
	});
});

// ─── vault.patch regression ──────────────────────────────────────────────────

describe("vault.patch (regression after findSection extraction)", () => {
	test("replaces section body, preserves heading", async () => {
		const file = join(tmpDir, "patch-test.md");
		await Bun.write(
			file,
			"# Doc\n## Goals\n- old goal 1\n- old goal 2\n## Notes\nsome notes",
		);
		const result = await vaultPatchTool.execute(
			{ path: "patch-test.md", heading: "Goals", newContent: "- new goal" },
			makeContext(),
		);
		expect(result).toContain('Patched section "Goals"');
		const content = await Bun.file(file).text();
		expect(content).toBe("# Doc\n## Goals\n- new goal\n## Notes\nsome notes");
	});

	test("replaces last section (extends to EOF)", async () => {
		const file = join(tmpDir, "patch-last.md");
		await Bun.write(file, "## A\ncontent a\n## B\nold content");
		const result = await vaultPatchTool.execute(
			{ path: "patch-last.md", heading: "B", newContent: "new content" },
			makeContext(),
		);
		expect(result).toContain('Patched section "B"');
		const content = await Bun.file(file).text();
		expect(content).toBe("## A\ncontent a\n## B\nnew content");
	});

	test("returns error when heading not found", async () => {
		const file = join(tmpDir, "patch-missing.md");
		await Bun.write(file, "## A\ncontent");
		const result = await vaultPatchTool.execute(
			{ path: "patch-missing.md", heading: "Missing", newContent: "x" },
			makeContext(),
		);
		expect(result).toContain('Heading "Missing" not found');
	});

	test("returns error when file not found", async () => {
		const result = await vaultPatchTool.execute(
			{ path: "no-such-file.md", heading: "X", newContent: "x" },
			makeContext(),
		);
		expect(result).toContain("Note not found");
	});
});
