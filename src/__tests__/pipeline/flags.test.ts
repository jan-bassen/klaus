import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import {
	getKnownoverrides,
	loadoverrides,
	type overrideDef,
	overrideRegistry,
	parseoverrides,
	resolveoverrides,
	stripoverrides,
} from "@/pipeline/overrides";

// ── Setup: load all override definitions before tests ──────────────────────

const yamlPath = path.join(import.meta.dir, "..", "fixtures", "overrides.yaml");

beforeAll(async () => {
	await loadoverrides(yamlPath);
});

// Add a test-only override for parseoverrides/stripoverrides tests
beforeAll(() => {
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

// ── Loader ───────────────────────────────────────────────────────────────────

describe("loadoverrides", () => {
	test("discovers all 19 presets", () => {
		const canonical = new Set(
			[...overrideRegistry.values()].map((f) => f.name),
		);
		// Remove the test-only entry
		canonical.delete("test");
		expect(canonical.size).toBe(19);
	});

	test("registers aliases alongside canonical names", () => {
		expect(overrideRegistry.get("s")?.name).toBe("small");
		expect(overrideRegistry.get("v")?.name).toBe("voice");
		expect(overrideRegistry.get("nt")?.name).toBe("no-tools");
	});
});

// ── Registry aliases ─────────────────────────────────────────────────────────

describe("overrideRegistry aliases", () => {
	test("alias keys resolve to the correct overrideDef", () => {
		expect(overrideRegistry.get("s")?.name).toBe("small");
		expect(overrideRegistry.get("m")?.name).toBe("medium");
		expect(overrideRegistry.get("l")?.name).toBe("large");
		expect(overrideRegistry.get("v")?.name).toBe("voice");
		expect(overrideRegistry.get("nt")?.name).toBe("no-tools");
	});

	test("getKnownoverrides includes aliases", () => {
		const known = getKnownoverrides();
		expect(known).toContain("small");
		expect(known).toContain("s");
		expect(known).toContain("nt");
	});
});

// ── resolveoverrides ───────────────────────────────────────────────────────

describe("resolveoverrides", () => {
	test("returns empty object for no flags", () => {
		expect(resolveoverrides({})).toEqual({});
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
		expect(resolveoverrides(input)).toEqual(expected);
	});

	test("combines multiple flags", () => {
		expect(resolveoverrides({ voice: true, large: true })).toEqual({
			forceVoice: true,
			modelTier: "large",
		});
	});

	test("ignores false flags", () => {
		expect(resolveoverrides({ voice: false, clean: false })).toEqual({});
	});

	test("ignores unknown flags", () => {
		expect(resolveoverrides({ unknown: true })).toEqual({});
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
		const result = resolveoverrides(input);
		expect(result[key as keyof typeof result]).toBe(expected);
	});
});

// ── parseoverrides ─────────────────────────────────────────────────────────

const flagA = "test";
const flagB = "voice";

describe("parseoverrides", () => {
	test("returns {} when text is undefined", () => {
		expect(parseoverrides(makeMsg(undefined))).toEqual({});
	});

	test("returns {} when text is empty", () => {
		expect(parseoverrides(makeMsg(""))).toEqual({});
	});

	test("returns {} when no flags in text", () => {
		expect(parseoverrides(makeMsg("just a normal message"))).toEqual({});
	});

	test("parses a single known flag at the start", () => {
		expect(parseoverrides(makeMsg(`!${flagA} tell me more`))).toEqual({
			[flagA]: true,
		});
	});

	test("parses a single known flag at the end", () => {
		expect(parseoverrides(makeMsg(`explain this !${flagA}`))).toEqual({
			[flagA]: true,
		});
	});

	test("parses a flag mid-sentence", () => {
		expect(
			parseoverrides(makeMsg(`please !${flagA} give me the data`)),
		).toEqual({
			[flagA]: true,
		});
	});

	test("parses multiple known flags", () => {
		const text = `!${flagA} !${flagB} explain`;
		const expected = { [flagA]: true, [flagB]: true };
		expect(parseoverrides(makeMsg(text))).toEqual(expected);
	});

	test("ignores unknown flags", () => {
		expect(parseoverrides(makeMsg("!banana explain"))).toEqual({});
	});

	test("returns only known flags when mixed with unknown", () => {
		expect(parseoverrides(makeMsg(`!${flagA} !banana`))).toEqual({
			[flagA]: true,
		});
	});

	test("handles duplicate flags idempotently", () => {
		expect(parseoverrides(makeMsg(`!${flagA} !${flagA}`))).toEqual({
			[flagA]: true,
		});
	});

	test("is case-sensitive — uppercase flags are not recognized", () => {
		const upper = flagA.charAt(0).toUpperCase() + flagA.slice(1);
		expect(parseoverrides(makeMsg(`!${upper}`))).toEqual({});
	});

	test("does not match a bare ! with no name", () => {
		expect(parseoverrides(makeMsg("hey ! what"))).toEqual({});
	});

	test("parses all flags loaded in registry (canonical names)", () => {
		const canonicalNames = [
			...new Set([...overrideRegistry.values()].map((f) => f.name)),
		];
		const text = canonicalNames.map((f) => `!${f}`).join(" ");
		const expected = Object.fromEntries(canonicalNames.map((f) => [f, true]));
		expect(parseoverrides(makeMsg(text))).toEqual(expected);
	});

	test("alias resolves to canonical name", () => {
		expect(parseoverrides(makeMsg("!s hello"))).toEqual({ small: true });
	});

	test("multiple aliases resolve to canonical names", () => {
		expect(parseoverrides(makeMsg("!s !v !nt explain"))).toEqual({
			small: true,
			voice: true,
			"no-tools": true,
		});
	});

	test("mixing canonical names and aliases", () => {
		expect(parseoverrides(makeMsg("!small !v text"))).toEqual({
			small: true,
			voice: true,
		});
	});
});

// ── stripoverrides ─────────────────────────────────────────────────────────

describe("stripoverrides", () => {
	test("removes a recognized flag and trims", () => {
		expect(stripoverrides(`!${flagA} tell me more`)).toBe("tell me more");
	});

	test("removes multiple recognized flags", () => {
		expect(stripoverrides(`!${flagA} !${flagB} explain this`)).toBe(
			"explain this",
		);
	});

	test("leaves unknown !words intact", () => {
		expect(stripoverrides("!banana explain")).toBe("!banana explain");
	});

	test("removes only recognized flags among mixed tokens", () => {
		expect(stripoverrides(`!${flagA} !banana data`)).toBe("!banana data");
	});

	test("collapses extra whitespace", () => {
		expect(stripoverrides(`  !${flagA}   tell   me  `)).toBe("tell me");
	});

	test("returns empty string when only flags remain", () => {
		expect(stripoverrides(`!${flagA} !${flagB}`)).toBe("");
	});

	test("returns the text unchanged when no flags present", () => {
		expect(stripoverrides("just a normal message")).toBe(
			"just a normal message",
		);
	});

	test("leaves bare ! intact", () => {
		expect(stripoverrides("hey ! what")).toBe("hey ! what");
	});

	test("strips alias tokens", () => {
		expect(stripoverrides("!s !v tell me more")).toBe("tell me more");
	});
});
