/**
 * `primitives/tools/skill.ts` — frontmatter parsing, scoped `skill_get` tool,
 * tools/toolset activation surfaced to the agent.
 *
 * Security note: `skill_get`'s input is constrained to the agent's declared
 * skill list via z.enum, so an agent can't read arbitrary skills from disk.
 * This test pins that contract.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	registerToolset,
	type ToolDefinition,
	toolsetRegistry,
} from "../../../src/primitives/tools/index.ts";
import {
	buildSkillTool,
	parseSkillMeta,
	skillRegistry,
} from "../../../src/primitives/tools/skill.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";
import { makeTurn } from "../../helpers/turn.ts";

function dummyTool(name: string): ToolDefinition {
	return {
		name,
		description: name,
		inputSchema: undefined as unknown as ToolDefinition["inputSchema"],
		execute: async () => "ok",
		kind: "builtin",
		capability: "tool",
	};
}

describe("primitives/tools/skill: parseSkillMeta", () => {
	it("extracts description / tools / toolsets from YAML frontmatter", () => {
		const raw = `---
description: workout plan
tools: [reply, math]
toolsets: [vault]
---
body`;
		expect(parseSkillMeta("workout-plan", raw)).toEqual({
			name: "workout-plan",
			description: "workout plan",
			tools: ["reply", "math"],
			toolsets: ["vault"],
		});
	});

	it("falls back to skill name when description missing", () => {
		expect(parseSkillMeta("misc", "no frontmatter here")).toEqual({
			name: "misc",
			description: "misc",
			tools: [],
			toolsets: [],
		});
	});

	it("returns safe defaults when frontmatter is present but schema-invalid", () => {
		// Valid YAML but doesn't match SkillFrontmatterSchema (tools should be array).
		const raw = "---\ntools: not-an-array\n---\nbody";
		const meta = parseSkillMeta("schema-bad", raw);
		expect(meta).toEqual({
			name: "schema-bad",
			description: "schema-bad",
			tools: [],
			toolsets: [],
		});
	});
});

describe("primitives/tools/skill: buildSkillTool", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = makeTmpDir();
		skillRegistry.clear();
		toolsetRegistry.clear();
	});

	afterEach(() => {
		skillRegistry.clear();
		toolsetRegistry.clear();
		rmTmpDir(tmp);
	});

	it("description lists each declared skill with its meta description", () => {
		skillRegistry.set("a", {
			name: "a",
			description: "alpha skill",
			tools: [],
			toolsets: [],
		});
		skillRegistry.set("b", {
			name: "b",
			description: "beta skill",
			tools: ["math"],
			toolsets: [],
		});

		const tool = buildSkillTool(["a", "b"], tmp);
		expect(tool.name).toBe("skill_get");
		expect(tool.description).toContain("a (alpha skill)");
		// Skills with extra tools get the [+tools] marker
		expect(tool.description).toContain("b (beta skill [+tools])");
	});

	it("execute returns the file body with frontmatter stripped", async () => {
		writeFileSync(
			path.join(tmp, "intro.md"),
			"---\ndescription: x\n---\nHello body",
		);
		skillRegistry.set("intro", {
			name: "intro",
			description: "x",
			tools: [],
			toolsets: [],
		});
		const tool = buildSkillTool(["intro"], tmp);
		const out = await tool.execute({ name: "intro" }, makeTurn());
		expect(out).toBe("Hello body");
	});

	it("execute appends activated tools list when meta declares them", async () => {
		writeFileSync(path.join(tmp, "trainer.md"), "body");
		registerToolset({
			name: "fitness",
			description: "fitness tools",
			tools: [dummyTool("workout_log"), dummyTool("workout_query")],
		});
		skillRegistry.set("trainer", {
			name: "trainer",
			description: "x",
			tools: ["math"],
			toolsets: ["fitness"],
		});
		const tool = buildSkillTool(["trainer"], tmp);
		const out = (await tool.execute({ name: "trainer" }, makeTurn())) as string;

		expect(out).toContain("body");
		expect(out).toContain("Tools now available:");
		expect(out).toContain("math");
		expect(out).toContain("workout_log");
		expect(out).toContain("workout_query");
	});

	it("execute returns an error object when the file is missing", async () => {
		skillRegistry.set("ghost", {
			name: "ghost",
			description: "x",
			tools: [],
			toolsets: [],
		});
		const tool = buildSkillTool(["ghost"], tmp);
		const out = await tool.execute({ name: "ghost" }, makeTurn());
		expect(out).toEqual({
			error: 'Failed to load skill "ghost": file not found or unreadable',
		});
	});

	it("input schema rejects skill names not in the agent's declared list", () => {
		skillRegistry.set("allowed", {
			name: "allowed",
			description: "x",
			tools: [],
			toolsets: [],
		});
		const tool = buildSkillTool(["allowed"], tmp);
		expect(tool.inputSchema.safeParse({ name: "allowed" }).success).toBe(true);
		expect(tool.inputSchema.safeParse({ name: "../etc/passwd" }).success).toBe(
			false,
		);
		expect(tool.inputSchema.safeParse({ name: "other" }).success).toBe(false);
	});
});
