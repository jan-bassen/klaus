/**
 * Override resolution in `pipeline/overrides.ts`.
 *
 * Pure in-process tests — no stores needed. Populate `overrideRegistry`
 * directly (or via `loadOverrides` pointing at a fixture yaml) and pass
 * mock `AgentDefinition`s to `buildTurnConfig`.
 *
 * Key invariants to prove:
 *   - Precedence: globalDefaults → frontmatter → preset (later wins).
 *   - `vault` map is DEEP-merged across all three layers.
 *   - `!voice` always clears `suppressVoice`.
 *   - `simulate: true` force-elevates `ghost: true` AND `skipHistory: true`.
 */

import { describe, it } from "vitest";

// import { buildTurnConfig, overrideRegistry } from "@/pipeline/overrides";

describe("pipeline/overrides.buildTurnConfig", () => {
	it.todo("global defaults fill modelTier when frontmatter doesn't set it");

	it.todo("frontmatter `settings.modelTier` wins over global defaults");

	it.todo("`!large` override wins over both global and frontmatter");

	it.todo(
		"vault map deep-merges across defaults + frontmatter + preset (all three keys present)",
	);

	it.todo(
		"`!voice` clears `suppressVoice` even when frontmatter set voice: 'off'",
	);

	it.todo("simulate override force-elevates ghost: true AND skipHistory: true");

	it.todo(
		"unknown override names are silently ignored (don't throw, don't pollute config)",
	);

	it.todo(
		"frontmatter tri-state ('auto' / 'default') doesn't over-write unset fields from defaults",
	);
});

describe("pipeline/overrides.parseOverrides + stripOverrides", () => {
	it.todo(
		"parseOverrides resolves aliases to canonical names (e.g. `!v` → `voice`)",
	);

	it.todo(
		"stripOverrides removes recognised tokens while leaving unrecognised `!words` intact",
	);
});
