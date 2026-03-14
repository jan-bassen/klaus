import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

mock.module("@/logger", () => ({
	log: {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
	},
}));

import { buildSkillTool, loadSkills, skillRegistry } from "@/tools/skill";
import type { TurnContext } from "@/types";

const fixtureDir = path.join(import.meta.dir, "__skill-fixtures");
const dummyContext = {} as TurnContext;

function writeSkill(name: string, content: string): void {
	writeFileSync(path.join(fixtureDir, `${name}.md`), content);
}

describe("loadSkills", () => {
	beforeEach(() => {
		skillRegistry.clear();
		mkdirSync(fixtureDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	test("parses description from frontmatter", async () => {
		writeSkill(
			"workout",
			"---\ndescription: Weekly training split\n---\n# Workout Plan\nDo stuff.",
		);
		await loadSkills(fixtureDir);
		expect(skillRegistry.get("workout")).toEqual({
			name: "workout",
			description: "Weekly training split",
		});
	});

	test("uses filename as description when no frontmatter", async () => {
		writeSkill("meal", "# Meal Template\nEat food.");
		await loadSkills(fixtureDir);
		expect(skillRegistry.get("meal")?.description).toBe("meal");
	});

	test("uses filename as description when frontmatter has no description", async () => {
		writeSkill("notes", "---\ntags: [misc]\n---\n# Notes");
		await loadSkills(fixtureDir);
		expect(skillRegistry.get("notes")?.description).toBe("notes");
	});

	test("loads multiple skills", async () => {
		writeSkill("a", "---\ndescription: Skill A\n---\n# A");
		writeSkill("b", "---\ndescription: Skill B\n---\n# B");
		await loadSkills(fixtureDir);
		expect(skillRegistry.size).toBe(2);
	});
});

describe("buildSkillTool", () => {
	beforeEach(() => {
		skillRegistry.clear();
		mkdirSync(fixtureDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	test("returns a valid ToolDefinition", () => {
		const tool = buildSkillTool(["workout"], fixtureDir);
		expect(tool.name).toBe("skill.get");
		expect(tool.kind).toBe("builtin");
		expect(tool.capability).toBe("resource");
		expect(tool.description).toContain("workout");
	});

	test("description includes skill descriptions from registry", async () => {
		writeSkill(
			"workout",
			"---\ndescription: Weekly training split\n---\n# Workout",
		);
		writeSkill(
			"meal",
			"---\ndescription: Macro-balanced meal structure\n---\n# Meal",
		);
		await loadSkills(fixtureDir);
		const tool = buildSkillTool(["workout", "meal"], fixtureDir);
		expect(tool.description).toContain("workout (Weekly training split)");
		expect(tool.description).toContain("meal (Macro-balanced meal structure)");
	});

	test("description falls back to name when skill not in registry", () => {
		const tool = buildSkillTool(["unknown"], fixtureDir);
		expect(tool.description).toContain("unknown");
		expect(tool.description).not.toContain("(");
	});

	test("execute returns content without frontmatter", async () => {
		writeSkill(
			"workout",
			"---\ndescription: Weekly training split\n---\n# Workout Plan\n\nDo 3 sets of squats.",
		);
		const tool = buildSkillTool(["workout"], fixtureDir);
		const result = await tool.execute({ name: "workout" }, dummyContext);
		expect(result).toBe("# Workout Plan\n\nDo 3 sets of squats.");
	});

	test("execute returns full content when no frontmatter", async () => {
		writeSkill("plain", "# Plain Skill\n\nNo frontmatter here.");
		const tool = buildSkillTool(["plain"], fixtureDir);
		const result = await tool.execute({ name: "plain" }, dummyContext);
		expect(result).toBe("# Plain Skill\n\nNo frontmatter here.");
	});

	test("inputSchema accepts valid skill names", () => {
		const tool = buildSkillTool(["a", "b"], fixtureDir);
		const valid = tool.inputSchema.safeParse({ name: "a" });
		expect(valid.success).toBe(true);
	});

	test("inputSchema rejects names not in the enum", () => {
		const tool = buildSkillTool(["a"], fixtureDir);
		const invalid = tool.inputSchema.safeParse({ name: "nonexistent" });
		expect(invalid.success).toBe(false);
	});

	test("execute returns error object for missing file", async () => {
		const tool = buildSkillTool(["missing"], fixtureDir);
		const result = await tool.execute({ name: "missing" }, dummyContext);
		expect(result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("missing") }),
		);
	});
});
