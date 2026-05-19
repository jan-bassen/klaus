/**
 * `pipeline/prompts.ts` — template rendering, system prompt compilation, sampling resolution.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../../src/infra/config.ts";
import {
	buildAgentMessage,
	buildSystemPrompt,
	invalidateTemplate,
	loadTemplates,
	renderTemplate,
	resolveSampling,
	textOnlyUserContent,
	type UserContent,
} from "../../src/pipeline/prompts.ts";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.ts";

function writeTemplate(dir: string, name: string, content: string): void {
	writeFileSync(path.join(dir, `${name}.md`), content);
}

describe("pipeline/prompts: resolveSampling", () => {
	afterEach(() => {
		// Reset sampling to a clean state
		settings.sampling = {};
	});

	it("returns empty object when no presets and no global sampling", () => {
		settings.sampling = {};
		expect(resolveSampling({})).toEqual({});
	});

	it("cold preset → coldTemperature (falls back to 0 when unset)", () => {
		settings.sampling = {};
		const result = resolveSampling({ temperaturePreset: "cold" });
		expect(result.temperature).toBe(0);
	});

	it("cold preset → coldTemperature from settings", () => {
		settings.sampling = { coldTemperature: 0.1 };
		expect(resolveSampling({ temperaturePreset: "cold" }).temperature).toBe(
			0.1,
		);
	});

	it("hot preset → hotTemperature (falls back to 1 when unset)", () => {
		settings.sampling = {};
		expect(resolveSampling({ temperaturePreset: "hot" }).temperature).toBe(1);
	});

	it("hot preset → hotTemperature from settings", () => {
		settings.sampling = { hotTemperature: 0.9 };
		expect(resolveSampling({ temperaturePreset: "hot" }).temperature).toBe(0.9);
	});

	it("creative topP preset → creativeTopP (falls back to 0.95)", () => {
		settings.sampling = {};
		expect(resolveSampling({ topPPreset: "creative" }).topP).toBe(0.95);
	});

	it("creative topP preset → creativeTopP from settings", () => {
		settings.sampling = { creativeTopP: 0.98 };
		expect(resolveSampling({ topPPreset: "creative" }).topP).toBe(0.98);
	});

	it("rigid topP preset → rigidTopP (falls back to 0.1)", () => {
		settings.sampling = {};
		expect(resolveSampling({ topPPreset: "rigid" }).topP).toBe(0.1);
	});

	it("rigid topP preset → rigidTopP from settings", () => {
		settings.sampling = { rigidTopP: 0.05 };
		expect(resolveSampling({ topPPreset: "rigid" }).topP).toBe(0.05);
	});

	it("passes through global temperature when no preset", () => {
		settings.sampling = { temperature: 0.5 };
		expect(resolveSampling({}).temperature).toBe(0.5);
	});

	it("passes through global topP when no preset", () => {
		settings.sampling = { topP: 0.8 };
		expect(resolveSampling({}).topP).toBe(0.8);
	});

	it("reasoningEffort maps to reasoning.effort", () => {
		expect(resolveSampling({ reasoningEffort: "high" }).reasoning).toEqual({
			effort: "high",
		});
		expect(resolveSampling({ reasoningEffort: "low" }).reasoning).toEqual({
			effort: "low",
		});
	});

	it("no reasoningEffort → no reasoning field in output", () => {
		expect(resolveSampling({}).reasoning).toBeUndefined();
	});
});

const ALL_TEMPLATE_NAMES = [
	"message-user",
	"message-agent",
	"error",
	"report",
	"persistence",
] as const;

describe("pipeline/prompts: renderTemplate", () => {
	let tmpDir: string;
	let originalTemplatesDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		originalTemplatesDir = settings.vault.templatesDir;
		settings.vault.templatesDir = tmpDir;
		// Clear compiled cache — the fresh (empty) tmpDir causes every
		// invalidateTemplate call to delete the cached entry.
		for (const name of ALL_TEMPLATE_NAMES) invalidateTemplate(name);
	});

	afterEach(() => {
		settings.vault.templatesDir = originalTemplatesDir;
		for (const name of ALL_TEMPLATE_NAMES) invalidateTemplate(name);
		rmTmpDir(tmpDir);
	});

	it("compiles Handlebars and collapses 3+ blank lines to 2", () => {
		writeTemplate(tmpDir, "message-user", "Hello {{name}}!\n\n\nExtra blank");
		const out = renderTemplate("message-user", { name: "World" });
		expect(out).toBe("Hello World!\n\nExtra blank");
	});

	it("throws a descriptive error when template file is missing", () => {
		expect(() => renderTemplate("message-user", {})).toThrow(
			"Missing template",
		);
	});

	it("noEscape passes raw angle brackets / markdown without escaping", () => {
		writeTemplate(tmpDir, "message-user", "{{content}}");
		const out = renderTemplate("message-user", {
			content: "<b>bold</b> & stuff",
		});
		expect(out).toBe("<b>bold</b> & stuff");
	});

	it("loadTemplates loads all .md files from templatesDir", () => {
		writeTemplate(tmpDir, "message-user", "user: {{text}}");
		writeTemplate(tmpDir, "message-agent", "agent: {{message}}");
		loadTemplates();
		expect(renderTemplate("message-user", { text: "hi" })).toBe("user: hi");
		expect(renderTemplate("message-agent", { message: "hey" })).toBe(
			"agent: hey",
		);
	});

	it("invalidateTemplate hot-reloads the file from disk", () => {
		writeTemplate(tmpDir, "message-user", "v1 {{x}}");
		expect(renderTemplate("message-user", { x: "a" })).toBe("v1 a");

		writeTemplate(tmpDir, "message-user", "v2 {{x}}");
		invalidateTemplate("message-user");
		expect(renderTemplate("message-user", { x: "b" })).toBe("v2 b");
	});

	it("template registered as Handlebars partial can be used via {{> name}}", () => {
		writeTemplate(tmpDir, "message-user", "inner {{val}}");
		writeTemplate(tmpDir, "error", "outer: {{> message-user val=kind}}");
		loadTemplates();
		const out = renderTemplate("error", { kind: "timeout" });
		expect(out).toBe("outer: inner timeout");
	});
});

describe("pipeline/prompts: buildSystemPrompt", () => {
	it("interpolates variables and trims leading/trailing whitespace", () => {
		const out = buildSystemPrompt("  Agent: {{agent}}\n  ", { agent: "coach" });
		expect(out).toBe("Agent: coach");
	});

	it("collapses 3+ blank lines to 2", () => {
		const out = buildSystemPrompt("line1\n\n\n\nline2", {});
		expect(out).toBe("line1\n\nline2");
	});

	it("passes raw HTML through noEscape mode", () => {
		const out = buildSystemPrompt("{{html}}", { html: "<b>bold</b>" });
		expect(out).toBe("<b>bold</b>");
	});

	it("returns empty string for empty body with whitespace", () => {
		expect(buildSystemPrompt("   ", {})).toBe("");
	});
});

describe("pipeline/prompts: buildAgentMessage", () => {
	it("interpolates variables and supports user-var shortcuts", () => {
		const out = buildAgentMessage(
			'{{#if (eq schedule.label "morning")}}Hello $user.name{{/if}}',
			{ schedule: { label: "morning" }, user: { name: "Jan" } },
		);
		expect(out).toBe("Hello Jan");
	});
});

describe("pipeline/prompts: textOnlyUserContent", () => {
	it("keeps text parts and replaces image data URLs with a marker", () => {
		const content: UserContent = [
			{
				type: "image_url",
				imageUrl: { url: "data:image/png;base64,AAAABBBB" },
			},
			{ type: "text", text: "what is this?" },
		];

		expect(textOnlyUserContent(content)).toBe(
			"[image omitted from text-only follow-up/report]\nwhat is this?",
		);
	});
});
