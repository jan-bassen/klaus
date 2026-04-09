import { describe, expect, test } from "bun:test";
import type { FlagOverrides } from "@/core/flags";
import { applyModeDefaults } from "@/core/modes";
import type { AgentDefinition } from "@/types";

function makeDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "test",
		aliases: [],
		modelTier: "medium",
		tools: ["reply"],
		toolsets: [],
		providerTools: [],
		skills: [],
		persistent: false,
		voiceMode: "auto",
		acceptMode: "off",
		showToolsInContext: true,
		promptPath: "/tmp/test.md",
		...overrides,
	};
}

describe("applyModeDefaults", () => {
	// ── Voice mode ──────────────────────────────────────────────────────────

	test("voiceMode auto: leaves overrides untouched", () => {
		const result = applyModeDefaults({}, makeDef({ voiceMode: "auto" }));
		expect(result.forceVoice).toBeUndefined();
		expect(result.suppressVoice).toBeUndefined();
	});

	test("voiceMode on: sets forceVoice", () => {
		const result = applyModeDefaults({}, makeDef({ voiceMode: "on" }));
		expect(result.forceVoice).toBe(true);
		expect(result.suppressVoice).toBeUndefined();
	});

	test("voiceMode off: sets suppressVoice", () => {
		const result = applyModeDefaults({}, makeDef({ voiceMode: "off" }));
		expect(result.suppressVoice).toBe(true);
		expect(result.forceVoice).toBeUndefined();
	});

	test("voiceMode fixed: leaves overrides untouched (like auto)", () => {
		const result = applyModeDefaults({}, makeDef({ voiceMode: "fixed" }));
		expect(result.forceVoice).toBeUndefined();
		expect(result.suppressVoice).toBeUndefined();
	});

	test("!voice flag works with voiceMode fixed", () => {
		const flags: FlagOverrides = { forceVoice: true };
		const result = applyModeDefaults(flags, makeDef({ voiceMode: "fixed" }));
		expect(result.forceVoice).toBe(true);
		expect(result.suppressVoice).toBe(false);
	});

	test("!voice flag overrides voiceMode off", () => {
		const flags: FlagOverrides = { forceVoice: true };
		const result = applyModeDefaults(flags, makeDef({ voiceMode: "off" }));
		expect(result.forceVoice).toBe(true);
		expect(result.suppressVoice).toBe(false);
	});

	test("!voice flag preserved when voiceMode is auto", () => {
		const flags: FlagOverrides = { forceVoice: true };
		const result = applyModeDefaults(flags, makeDef({ voiceMode: "auto" }));
		expect(result.forceVoice).toBe(true);
		expect(result.suppressVoice).toBe(false);
	});

	// ── Accept mode ─────────────────────────────────────────────────────────

	test("acceptMode off: leaves autoAccept undefined", () => {
		const result = applyModeDefaults({}, makeDef({ acceptMode: "off" }));
		expect(result.autoAccept).toBeUndefined();
	});

	test("acceptMode on: sets autoAccept", () => {
		const result = applyModeDefaults({}, makeDef({ acceptMode: "on" }));
		expect(result.autoAccept).toBe(true);
	});

	test("!accept flag preserved regardless of acceptMode", () => {
		const flags: FlagOverrides = { autoAccept: true };
		const result = applyModeDefaults(flags, makeDef({ acceptMode: "off" }));
		expect(result.autoAccept).toBe(true);
	});

	// ── Provider ────────────────────────────────────────────────────────────

	test("agent provider sets overrides.provider", () => {
		const result = applyModeDefaults({}, makeDef({ provider: "gemini" }));
		expect(result.provider).toBe("gemini");
	});

	test("no agent provider: leaves overrides.provider undefined", () => {
		const result = applyModeDefaults({}, makeDef());
		expect(result.provider).toBeUndefined();
	});

	test("!provider flag overrides agent provider", () => {
		const flags: FlagOverrides = { provider: "chatgpt" };
		const result = applyModeDefaults(flags, makeDef({ provider: "claude" }));
		expect(result.provider).toBe("chatgpt");
	});

	// ── Combined ────────────────────────────────────────────────────────────

	test("multiple modes applied together", () => {
		const result = applyModeDefaults(
			{},
			makeDef({ voiceMode: "on", acceptMode: "on", provider: "claude" }),
		);
		expect(result.forceVoice).toBe(true);
		expect(result.autoAccept).toBe(true);
		expect(result.provider).toBe("claude");
	});

	test("does not mutate input overrides", () => {
		const flags: FlagOverrides = { modelTier: "large" };
		const result = applyModeDefaults(
			flags,
			makeDef({ voiceMode: "on", acceptMode: "on" }),
		);
		expect(result.modelTier).toBe("large");
		expect(result.forceVoice).toBe(true);
		// Original not mutated
		expect(flags.forceVoice).toBeUndefined();
	});
});
