/**
 * Override resolution in `pipeline/overrides.ts`.
 *
 * Pure in-process tests — no stores needed. Populate `overrideRegistry`
 * directly and pass mock `AgentDefinition`s to `buildTurnConfig`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { settings } from "@/infra/config";
import type { AgentDefinition } from "@/pipeline/agents";
import {
	buildTurnConfig,
	type OverrideDef,
	overrideRegistry,
	parseOverrides,
	stripOverrides,
} from "@/pipeline/overrides";

function register(def: OverrideDef): void {
	overrideRegistry.set(def.name, def);
	for (const a of def.aliases ?? []) overrideRegistry.set(a, def);
}

function makeAgent(
	patch: Partial<AgentDefinition["settings"]> = {},
): AgentDefinition {
	return {
		name: "test",
		aliases: [],
		tools: [],
		toolsets: [],
		providerTools: [],
		skills: [],
		settings: {
			voice: "auto",
			accept: false,
			temp: "default",
			topP: "default",
			reasoningEffort: "default",
			showTrace: true,
			report: "agent",
			...patch,
		},
		promptPath: "/tmp/x.md",
	} as unknown as AgentDefinition;
}

describe("pipeline/overrides.buildTurnConfig", () => {
	beforeEach(() => {
		register({
			name: "voice",
			aliases: ["v"],
			description: "",
			overrides: { forceVoice: true },
		});
		register({
			name: "large",
			aliases: ["l"],
			description: "",
			overrides: { modelTier: "large" },
		});
		register({
			name: "small",
			description: "",
			overrides: { modelTier: "small" },
		});
		register({
			name: "simulate",
			description: "",
			overrides: { simulate: true },
		});
	});

	it("global default modelTier fills when frontmatter doesn't set it", () => {
		const cfg = buildTurnConfig(makeAgent(), {});
		expect(cfg.modelTier).toBe(settings.agentDefaults.modelTier);
	});

	it("frontmatter modelTier wins over global defaults", () => {
		const cfg = buildTurnConfig(makeAgent({ modelTier: "small" }), {});
		expect(cfg.modelTier).toBe("small");
	});

	it("preset wins over frontmatter and global", () => {
		const cfg = buildTurnConfig(makeAgent({ modelTier: "small" }), {
			large: true,
		});
		expect(cfg.modelTier).toBe("large");
	});

	it("global defaultProvider fills when frontmatter doesn't set it", () => {
		const cfg = buildTurnConfig(makeAgent(), {});
		expect(cfg.provider).toBe(settings.defaultProvider);
	});

	it("frontmatter provider wins over global default", () => {
		const cfg = buildTurnConfig(makeAgent({ provider: "openai" }), {});
		expect(cfg.provider).toBe("openai");
	});

	it("preset provider wins over frontmatter and global", () => {
		register({
			name: "gemini",
			description: "",
			overrides: { provider: "gemini" },
		});
		const cfg = buildTurnConfig(makeAgent({ provider: "openai" }), {
			gemini: true,
		});
		expect(cfg.provider).toBe("gemini");
	});

	it("vault map deep-merges across global + frontmatter + preset", () => {
		register({
			name: "openPrivate",
			description: "",
			overrides: { vault: { Private: "full" } },
		});
		const agent = makeAgent({ vault: { Notes: "read" } });
		// settings.agentDefaults.vault is "*: full" by default.
		const cfg = buildTurnConfig(agent, { openPrivate: true });
		expect(cfg.vault).toMatchObject({
			"*": "full",
			Notes: "read",
			Private: "full",
		});
	});

	it("!voice clears suppressVoice even when frontmatter says voice off", () => {
		const cfg = buildTurnConfig(makeAgent({ voice: "off" }), { voice: true });
		expect(cfg.suppressVoice).toBe(false);
		expect(cfg.forceVoice).toBe(true);
	});

	it("simulate force-elevates ghost + skipHistory", () => {
		const cfg = buildTurnConfig(makeAgent(), { simulate: true });
		expect(cfg.simulate).toBe(true);
		expect(cfg.ghost).toBe(true);
		expect(cfg.skipHistory).toBe(true);
	});

	it("unknown override names are silently ignored", () => {
		const cfg = buildTurnConfig(makeAgent(), { nonsense: true });
		// Should still build cleanly and have global modelTier.
		expect(cfg.modelTier).toBe(settings.agentDefaults.modelTier);
	});
});

describe("pipeline/overrides.parseOverrides + stripOverrides", () => {
	beforeEach(() => {
		register({
			name: "voice",
			aliases: ["v"],
			description: "",
			overrides: { forceVoice: true },
		});
		register({
			name: "large",
			aliases: ["l"],
			description: "",
			overrides: { modelTier: "large" },
		});
	});

	it("parseOverrides resolves aliases to canonical names", () => {
		const out = parseOverrides({ text: "!v hello" });
		expect(out).toEqual({ voice: true });
	});

	it("multiple recognised tokens collected together", () => {
		const out = parseOverrides({ text: "!v !large hi" });
		expect(out).toEqual({ voice: true, large: true });
	});

	it("stripOverrides removes recognised tokens, leaves unknown ! intact", () => {
		const out = stripOverrides("!v hello !unknown world");
		expect(out).toBe("hello !unknown world");
	});

	it("parseOverrides ignores unrecognised !words", () => {
		expect(parseOverrides({ text: "!unknown hi" })).toEqual({});
	});
});
