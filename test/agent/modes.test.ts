import { describe, expect, test } from "vitest";
import type { TurnConfig } from "@/pipeline/overrides";
import { resolveAgentDefaults } from "@/pipeline/overrides";
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
		showToolsInContext: true,
		promptPath: "/tmp/test.md",
		...overrides,
	};
}

describe("resolveAgentDefaults", () => {
	// ── Voice defaults ──────────────────────────────────────────────────────

	test("no voice fields: leaves overrides untouched", () => {
		const result = resolveAgentDefaults({}, makeDef());
		expect(result.forceVoice).toBeUndefined();
		expect(result.suppressVoice).toBeUndefined();
	});

	test("agent with forceVoice: sets forceVoice in result", () => {
		const result = resolveAgentDefaults({}, makeDef({ forceVoice: true }));
		expect(result.forceVoice).toBe(true);
		expect(result.suppressVoice).toBeUndefined();
	});

	test("agent with suppressVoice: sets suppressVoice in result", () => {
		const result = resolveAgentDefaults({}, makeDef({ suppressVoice: true }));
		expect(result.suppressVoice).toBe(true);
		expect(result.forceVoice).toBeUndefined();
	});

	test("per-message override forceVoice wins over agent suppressVoice", () => {
		const overrides: TurnConfig = { forceVoice: true };
		const result = resolveAgentDefaults(
			overrides,
			makeDef({ suppressVoice: true }),
		);
		expect(result.forceVoice).toBe(true);
		expect(result.suppressVoice).toBe(false);
	});

	test("forceVoice in preset clears suppressVoice", () => {
		const overrides: TurnConfig = { forceVoice: true };
		const result = resolveAgentDefaults(overrides, makeDef());
		expect(result.forceVoice).toBe(true);
		expect(result.suppressVoice).toBe(false);
	});

	// ── Accept defaults ─────────────────────────────────────────────────────

	test("no autoAccept: leaves autoAccept undefined", () => {
		const result = resolveAgentDefaults({}, makeDef());
		expect(result.autoAccept).toBeUndefined();
	});

	test("agent with autoAccept: sets autoAccept in result", () => {
		const result = resolveAgentDefaults({}, makeDef({ autoAccept: true }));
		expect(result.autoAccept).toBe(true);
	});

	test("per-message autoAccept preserved regardless of agent default", () => {
		const overrides: TurnConfig = { autoAccept: true };
		const result = resolveAgentDefaults(overrides, makeDef());
		expect(result.autoAccept).toBe(true);
	});

	// ── Provider ────────────────────────────────────────────────────────────

	test("agent provider sets overrides.provider", () => {
		const result = resolveAgentDefaults({}, makeDef({ provider: "gemini" }));
		expect(result.provider).toBe("gemini");
	});

	test("no agent provider: leaves overrides.provider undefined", () => {
		const result = resolveAgentDefaults({}, makeDef());
		expect(result.provider).toBeUndefined();
	});

	test("per-message provider overrides agent provider", () => {
		const overrides: TurnConfig = { provider: "chatgpt" };
		const result = resolveAgentDefaults(
			overrides,
			makeDef({ provider: "claude" }),
		);
		expect(result.provider).toBe("chatgpt");
	});

	// ── Combined ────────────────────────────────────────────────────────────

	test("multiple agent defaults merge correctly", () => {
		const result = resolveAgentDefaults(
			{},
			makeDef({ forceVoice: true, autoAccept: true, provider: "claude" }),
		);
		expect(result.forceVoice).toBe(true);
		expect(result.autoAccept).toBe(true);
		expect(result.provider).toBe("claude");
	});

	test("does not mutate input overrides", () => {
		const overrides: TurnConfig = { modelTier: "large" };
		const result = resolveAgentDefaults(
			overrides,
			makeDef({ forceVoice: true, autoAccept: true }),
		);
		expect(result.modelTier).toBe("large");
		expect(result.forceVoice).toBe(true);
		expect(overrides.forceVoice).toBeUndefined();
	});
});
