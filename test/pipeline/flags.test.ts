import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
	getKnownOverrides,
	type OverrideDef,
	overrideRegistry,
	parseOverrides,
	resolveOverrides,
	stripOverrides,
} from "@/pipeline/overrides";

// Register test overrides inline instead of loading from YAML fixture
beforeAll(() => {
	const presets: Array<{
		name: string;
		aliases?: string[];
		description: string;
		overrides: Record<string, unknown>;
	}> = [
		{
			name: "voice",
			aliases: ["v"],
			description: "force voice reply",
			overrides: { forceVoice: true },
		},
		{
			name: "clean",
			aliases: ["cl"],
			description: "skip history",
			overrides: { skipHistory: true },
		},
		{
			name: "small",
			aliases: ["s"],
			description: "small model",
			overrides: { modelTier: "small" },
		},
		{
			name: "medium",
			aliases: ["m"],
			description: "medium model",
			overrides: { modelTier: "medium" },
		},
		{
			name: "large",
			aliases: ["l"],
			description: "large model",
			overrides: { modelTier: "large" },
		},
		{
			name: "accept",
			aliases: ["a"],
			description: "auto-accept",
			overrides: { autoAccept: true },
		},
		{
			name: "cold",
			aliases: ["c"],
			description: "cold temperature",
			overrides: { temperaturePreset: "cold" },
		},
		{
			name: "hot",
			aliases: ["h"],
			description: "hot temperature",
			overrides: { temperaturePreset: "hot" },
		},
		{
			name: "creative",
			aliases: ["cr"],
			description: "creative topP",
			overrides: { topPPreset: "creative" },
		},
		{
			name: "rigid",
			aliases: ["r"],
			description: "rigid topP",
			overrides: { topPPreset: "rigid" },
		},
		{
			name: "no-tools",
			aliases: ["nt"],
			description: "no tools",
			overrides: { toolChoice: "none" },
		},
		{
			name: "use-tools",
			aliases: ["ut"],
			description: "require tools",
			overrides: { toolChoice: "required" },
		},
		{
			name: "ghost",
			aliases: ["g"],
			description: "ghost mode",
			overrides: { ghost: true, skipHistory: true },
		},
		{
			name: "low",
			aliases: ["lo"],
			description: "low reasoning",
			overrides: { reasoningEffort: "low" },
		},
		{
			name: "high",
			aliases: ["hi"],
			description: "high reasoning",
			overrides: { reasoningEffort: "high" },
		},
		{
			name: "fast",
			aliases: ["f"],
			description: "fast mode",
			overrides: { fast: true },
		},
		{
			name: "claude",
			description: "claude provider",
			overrides: { provider: "claude" },
		},
		{
			name: "chatgpt",
			description: "chatgpt provider",
			overrides: { provider: "chatgpt" },
		},
		{
			name: "gemini",
			description: "gemini provider",
			overrides: { provider: "gemini" },
		},
	];

	overrideRegistry.clear();
	for (const p of presets) {
		const def: OverrideDef = {
			name: p.name,
			description: p.description,
			overrides: p.overrides,
		};
		overrideRegistry.set(p.name, def);
		for (const alias of p.aliases ?? []) {
			overrideRegistry.set(alias, def);
		}
	}

	// Add a test-only override
	overrideRegistry.set("test", {
		name: "test",
		description: "mark as a test message",
		overrides: {},
	});
});

afterEach(() => {
	if (!overrideRegistry.has("test")) {
		overrideRegistry.set("test", {
			name: "test",
			description: "mark as a test message",
			overrides: {},
		});
	}
});

function makeMsg(text?: string): { text?: string } {
	if (text !== undefined) return { text };
	return {};
}

// ── Registry aliases ─────────────────────────────────────────────────────

describe("overrideRegistry aliases", () => {
	test("alias keys resolve to the correct OverrideDef", () => {
		expect(overrideRegistry.get("s")?.name).toBe("small");
		expect(overrideRegistry.get("m")?.name).toBe("medium");
		expect(overrideRegistry.get("l")?.name).toBe("large");
		expect(overrideRegistry.get("v")?.name).toBe("voice");
		expect(overrideRegistry.get("nt")?.name).toBe("no-tools");
	});

	test("getKnownOverrides includes aliases", () => {
		const known = getKnownOverrides();
		expect(known).toContain("small");
		expect(known).toContain("s");
		expect(known).toContain("nt");
	});
});

// ── resolveOverrides ───────────────────────────────────────────────────────

describe("resolveOverrides", () => {
	test("returns empty object for no flags", () => {
		expect(resolveOverrides({})).toEqual({});
	});

	test.each([
		["voice", { voice: true }, { forceVoice: true }],
		["clean", { clean: true }, { skipHistory: true }],
		["small", { small: true }, { modelTier: "small" }],
		["medium", { medium: true }, { modelTier: "medium" }],
		["large", { large: true }, { modelTier: "large" }],
		["accept", { accept: true }, { autoAccept: true }],
		["cold", { cold: true }, { temperaturePreset: "cold" }],
		["hot", { hot: true }, { temperaturePreset: "hot" }],
		["creative", { creative: true }, { topPPreset: "creative" }],
		["rigid", { rigid: true }, { topPPreset: "rigid" }],
		["no-tools", { "no-tools": true }, { toolChoice: "none" }],
		["use-tools", { "use-tools": true }, { toolChoice: "required" }],
		["ghost", { ghost: true }, { ghost: true, skipHistory: true }],
		["low", { low: true }, { reasoningEffort: "low" }],
		["high", { high: true }, { reasoningEffort: "high" }],
		["fast", { fast: true }, { fast: true }],
		["claude", { claude: true }, { provider: "claude" }],
		["chatgpt", { chatgpt: true }, { provider: "chatgpt" }],
		["gemini", { gemini: true }, { provider: "gemini" }],
	] as const)("%s flag maps correctly", (_label, input, expected) => {
		expect(resolveOverrides(input)).toEqual(expected);
	});

	test("combines multiple flags", () => {
		expect(resolveOverrides({ voice: true, large: true })).toEqual({
			forceVoice: true,
			modelTier: "large",
		});
	});

	test("ignores false flags", () => {
		expect(resolveOverrides({ voice: false, clean: false })).toEqual({});
	});

	test("ignores unknown flags", () => {
		expect(resolveOverrides({ unknown: true })).toEqual({});
	});

	test.each([
		["model tier", { small: true, large: true }, "modelTier", "large"],
		["temperature", { cold: true, hot: true }, "temperaturePreset", "hot"],
		["topP", { creative: true, rigid: true }, "topPPreset", "rigid"],
		[
			"toolChoice",
			{ "no-tools": true, "use-tools": true },
			"toolChoice",
			"required",
		],
		["reasoning effort", { low: true, high: true }, "reasoningEffort", "high"],
	] as const)("last %s flag wins", (_label, input, key, expected) => {
		const result = resolveOverrides(input);
		expect(result[key as keyof typeof result]).toBe(expected);
	});
});

// ── parseOverrides ─────────────────────────────────────────────────────────

const flagA = "test";
const flagB = "voice";

describe("parseOverrides", () => {
	test("returns {} when text is undefined", () => {
		expect(parseOverrides(makeMsg(undefined))).toEqual({});
	});

	test("returns {} when text is empty", () => {
		expect(parseOverrides(makeMsg(""))).toEqual({});
	});

	test("returns {} when no flags in text", () => {
		expect(parseOverrides(makeMsg("just a normal message"))).toEqual({});
	});

	test("parses a single known flag at the start", () => {
		expect(parseOverrides(makeMsg(`!${flagA} tell me more`))).toEqual({
			[flagA]: true,
		});
	});

	test("parses a single known flag at the end", () => {
		expect(parseOverrides(makeMsg(`explain this !${flagA}`))).toEqual({
			[flagA]: true,
		});
	});

	test("parses a flag mid-sentence", () => {
		expect(
			parseOverrides(makeMsg(`please !${flagA} give me the data`)),
		).toEqual({
			[flagA]: true,
		});
	});

	test("parses multiple known flags", () => {
		const text = `!${flagA} !${flagB} explain`;
		const expected = { [flagA]: true, [flagB]: true };
		expect(parseOverrides(makeMsg(text))).toEqual(expected);
	});

	test("ignores unknown flags", () => {
		expect(parseOverrides(makeMsg("!banana explain"))).toEqual({});
	});

	test("returns only known flags when mixed with unknown", () => {
		expect(parseOverrides(makeMsg(`!${flagA} !banana`))).toEqual({
			[flagA]: true,
		});
	});

	test("handles duplicate flags idempotently", () => {
		expect(parseOverrides(makeMsg(`!${flagA} !${flagA}`))).toEqual({
			[flagA]: true,
		});
	});

	test("is case-sensitive — uppercase flags are not recognized", () => {
		const upper = flagA.charAt(0).toUpperCase() + flagA.slice(1);
		expect(parseOverrides(makeMsg(`!${upper}`))).toEqual({});
	});

	test("does not match a bare ! with no name", () => {
		expect(parseOverrides(makeMsg("hey ! what"))).toEqual({});
	});

	test("alias resolves to canonical name", () => {
		expect(parseOverrides(makeMsg("!s hello"))).toEqual({ small: true });
	});

	test("multiple aliases resolve to canonical names", () => {
		expect(parseOverrides(makeMsg("!s !v !nt explain"))).toEqual({
			small: true,
			voice: true,
			"no-tools": true,
		});
	});

	test("mixing canonical names and aliases", () => {
		expect(parseOverrides(makeMsg("!small !v text"))).toEqual({
			small: true,
			voice: true,
		});
	});
});

// ── stripOverrides ─────────────────────────────────────────────────────────

describe("stripOverrides", () => {
	test("removes a recognized flag and trims", () => {
		expect(stripOverrides(`!${flagA} tell me more`)).toBe("tell me more");
	});

	test("removes multiple recognized flags", () => {
		expect(stripOverrides(`!${flagA} !${flagB} explain this`)).toBe(
			"explain this",
		);
	});

	test("leaves unknown !words intact", () => {
		expect(stripOverrides("!banana explain")).toBe("!banana explain");
	});

	test("removes only recognized flags among mixed words", () => {
		expect(stripOverrides(`!${flagA} !banana data`)).toBe("!banana data");
	});

	test("collapses extra whitespace", () => {
		expect(stripOverrides(`  !${flagA}   tell   me  `)).toBe("tell me");
	});

	test("returns empty string when only flags remain", () => {
		expect(stripOverrides(`!${flagA} !${flagB}`)).toBe("");
	});

	test("returns the text unchanged when no flags present", () => {
		expect(stripOverrides("just a normal message")).toBe(
			"just a normal message",
		);
	});

	test("leaves bare ! intact", () => {
		expect(stripOverrides("hey ! what")).toBe("hey ! what");
	});

	test("strips alias flags", () => {
		expect(stripOverrides("!s !v tell me more")).toBe("tell me more");
	});
});
