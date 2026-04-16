import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logError: vi.fn(),
	logDebug: vi.fn(),
}));

vi.mock("@/logger", () => ({
	log: {
		info: mocks.logInfo,
		warn: mocks.logWarn,
		error: mocks.logError,
		debug: mocks.logDebug,
	},
}));

import {
	registerTool,
	registerToolset,
	toolRegistry,
	toolsetRegistry,
} from "@/tools";
import { buildSkillTool, loadSkills, skillRegistry } from "@/tools/skill";
import type { ToolDefinition, ToolsetDefinition, TurnContext } from "@/types";

const fixtureDir = path.join(import.meta.dirname, "__skill-fixtures");
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
			tools: [],
			toolsets: [],
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

describe("skill tools", () => {
	const dummyTool: ToolDefinition = {
		name: "vault.read",
		description: "Read a vault file",
		inputSchema: z.object({ path: z.string() }),
		execute: async () => "content",
		kind: "builtin",
		capability: "tool",
	};

	const dummyToolset: ToolsetDefinition = {
		name: "dispatch",
		description: "Dispatch agents",
		tools: [
			{
				name: "dispatch.agent",
				description: "Dispatch an agent",
				inputSchema: z.object({ agent: z.string() }),
				execute: async () => "dispatched",
				kind: "builtin",
				capability: "tool",
			},
		],
	};

	beforeEach(() => {
		skillRegistry.clear();
		toolRegistry.clear();
		toolsetRegistry.clear();
		mkdirSync(fixtureDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(fixtureDir, { recursive: true, force: true });
	});

	test("loadSkills parses tools and toolsets from frontmatter", async () => {
		writeSkill(
			"advanced",
			"---\ndescription: Advanced skill\ntools:\n  - vault.read\ntoolsets:\n  - dispatch\n---\n# Content",
		);
		await loadSkills(fixtureDir);
		const meta = skillRegistry.get("advanced");
		expect(meta?.tools).toEqual(["vault.read"]);
		expect(meta?.toolsets).toEqual(["dispatch"]);
	});

	test("description marks skills with tools as [+tools]", async () => {
		writeSkill(
			"with-tools",
			"---\ndescription: Has tools\ntools:\n  - vault.read\n---\n# Content",
		);
		writeSkill("no-tools", "---\ndescription: No tools\n---\n# Content");
		await loadSkills(fixtureDir);
		const tool = buildSkillTool(["with-tools", "no-tools"], fixtureDir);
		expect(tool.description).toContain("with-tools (Has tools [+tools])");
		expect(tool.description).toContain("no-tools (No tools)");
		expect(tool.description).not.toContain("no-tools (No tools [+tools])");
	});

	test("execute appends activated tool names for skill with tools", async () => {
		registerTool(dummyTool);
		writeSkill(
			"tooled",
			"---\ndescription: Skill with tools\ntools:\n  - vault.read\n---\n# Skill Body",
		);
		await loadSkills(fixtureDir);
		const tool = buildSkillTool(["tooled"], fixtureDir);
		const result = await tool.execute({ name: "tooled" }, dummyContext);
		expect(result).toContain("# Skill Body");
		expect(result).toContain("Tools now available: vault.read");
	});

	test("execute appends toolset tool names for skill with toolsets", async () => {
		registerToolset(dummyToolset);
		writeSkill(
			"dispatchy",
			"---\ndescription: Dispatch skill\ntoolsets:\n  - dispatch\n---\n# Dispatch Body",
		);
		await loadSkills(fixtureDir);
		const tool = buildSkillTool(["dispatchy"], fixtureDir);
		const result = await tool.execute({ name: "dispatchy" }, dummyContext);
		expect(result).toContain("# Dispatch Body");
		expect(result).toContain("Tools now available: dispatch.agent");
	});

	test("execute does not append tools note for skill without tools", async () => {
		writeSkill("plain", "---\ndescription: Plain skill\n---\n# Plain Body");
		await loadSkills(fixtureDir);
		const tool = buildSkillTool(["plain"], fixtureDir);
		const result = await tool.execute({ name: "plain" }, dummyContext);
		expect(result).toBe("# Plain Body");
		expect(result).not.toContain("Tools now available");
	});
});
