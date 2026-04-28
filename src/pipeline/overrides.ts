/**
 * Per-turn override system: `!preset` words in a user message, the
 * `overrides.yml` registry, the resolved `TurnConfig` shape, and the layered
 * merge that produces the effective per-turn config.
 *
 *   globalDefaults → agent frontmatter → parsed `!overrides` → TurnConfig
 *
 * Consumers read `turn.config` downstream — they never see the layers.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type AgentVaultEntry, modelTiers, settings } from "../infra/config.ts";
import { log } from "../infra/logger.ts";
import { readText } from "../infra/runtime.ts";
import type { AgentDefinition } from "./agents.ts";
// ── TurnConfig ─────────────────────────────────────────────────────────────

/**
 * Effective configuration for one turn — merged from `settings.agentDefaults`,
 * the agent's `settings:` frontmatter, and per-message `!overrides` (later
 * layer wins; `vault` is deep-merged across all three).
 *
 * Fields here are what downstream code actually reads. Some come from the
 * agent's `settings:` block (mapped via `fromFrontmatter`), some only ever
 * come from `!overrides` (e.g. `ghost`, `fast`, `skipHistory`, `toolChoice`).
 */
export interface TurnConfig {
	// from agent settings + overrides
	provider?: string;
	modelTier?: (typeof modelTiers)[number];
	forceVoice?: boolean;
	suppressVoice?: boolean;
	temperaturePreset?: "cold" | "hot";
	topPPreset?: "creative" | "rigid";
	reasoningEffort?: "low" | "high";
	stepLimit?: number;
	historyLimit?: number;
	historyScope?: "full" | "agent";
	showTrace?: boolean;
	report?: "full" | "agent" | "none";
	vault?: Record<string, AgentVaultEntry>;
	// override-only
	skipHistory?: boolean;
	ghost?: boolean;
	fast?: boolean;
	/**
	 * `!simulate` — ephemeral run. Tool wrapper routes by `sideEffect` (no
	 * external messages, no persistent writes). Implies `ghost` so neither the
	 * inbound message nor the trace are persisted.
	 */
	simulate?: boolean;
	toolChoice?: "none" | "required";
	[key: string]: unknown;
}

/** Schema for a TurnConfig fragment as it appears under an `overrides:` block. */
const turnConfigSchema = z
	.object({
		provider: z.string().optional(),
		modelTier: z.enum(modelTiers).optional(),
		forceVoice: z.boolean().optional(),
		suppressVoice: z.boolean().optional(),
		temperaturePreset: z.enum(["cold", "hot"]).optional(),
		topPPreset: z.enum(["creative", "rigid"]).optional(),
		reasoningEffort: z.enum(["low", "high"]).optional(),
		stepLimit: z.number().optional(),
		historyLimit: z.number().optional(),
		historyScope: z.enum(["full", "agent"]).optional(),
		showTrace: z.boolean().optional(),
		report: z.enum(["full", "agent", "none"]).optional(),
		vault: z
			.record(
				z.string(),
				z.union([
					z.enum(["none", "read", "full"]),
					z
						.object({
							default: z.enum(["none", "read", "full"]),
							confirm: z.enum(["none", "read", "append", "full"]).optional(),
						})
						.strict(),
				]),
			)
			.optional(),
		skipHistory: z.boolean().optional(),
		ghost: z.boolean().optional(),
		fast: z.boolean().optional(),
		simulate: z.boolean().optional(),
		toolChoice: z.enum(["none", "required"]).optional(),
	})
	.passthrough();

// ── Override preset registry ───────────────────────────────────────────────

/** A `!name` preset loaded from `Klaus/overrides.yml`. */
export interface OverrideDef {
	name: string;
	aliases?: string[];
	description: string;
	overrides: TurnConfig;
}

const YamlEntrySchema = z.object({
	aliases: z.array(z.string()).optional(),
	description: z.string(),
	overrides: turnConfigSchema,
});

const YamlFileSchema = z.record(z.string(), YamlEntrySchema);

/** Lookup table — indexed by both canonical name and alias. */
export const overrideRegistry = new Map<string, OverrideDef>();

function register(def: OverrideDef): void {
	overrideRegistry.set(def.name, def);
	for (const alias of def.aliases ?? []) overrideRegistry.set(alias, def);
	log.debug(`[config] override registered: ${def.name}`);
}

function getKnownOverrides(): string[] {
	return [...overrideRegistry.keys()];
}

/** Load presets from `Klaus/overrides.yml`. Called at startup and on hot-reload. */
export async function loadOverrides(yamlPath?: string): Promise<void> {
	overrideRegistry.clear();
	const filePath = yamlPath ?? `${settings.vault.internalPath}/overrides.yml`;

	let raw: string;
	try {
		raw = await readText(filePath);
	} catch {
		log.warn("[config] overrides.yml not found, no presets loaded");
		return;
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err) {
		log.warn("[config] failed to parse overrides.yml", {
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	const result = YamlFileSchema.safeParse(parsed);
	if (!result.success) {
		log.warn("[config] invalid overrides.yml schema", {
			error: result.error.message,
		});
		return;
	}

	for (const [name, entry] of Object.entries(result.data)) {
		register({
			name,
			...(entry.aliases ? { aliases: entry.aliases } : {}),
			description: entry.description,
			overrides: entry.overrides as TurnConfig,
		});
	}

	const count = new Set([...overrideRegistry.values()]).size;
	log.info(`[config] loaded ${count} override presets`);
}

// ── Text-level parsing of !overrides ───────────────────────────────────────

function canonicalOverride(word: string): string | null {
	if (!word.startsWith("!") || word.length <= 1) return null;
	const def = overrideRegistry.get(word.slice(1));
	return def ? def.name : null;
}

/** Pull recognised `!preset` words from text into a `{ name: true }` map. */
export function parseOverrides(msg: {
	text?: string;
}): Record<string, boolean> {
	if (!msg.text) return {};
	const active: Record<string, boolean> = {};
	for (const word of msg.text.split(/\s+/)) {
		const name = canonicalOverride(word);
		if (name) active[name] = true;
	}
	return active;
}

/** Drop recognised `!preset` words from text and tidy whitespace. */
export function stripOverrides(text: string): string {
	return text
		.split(/\s+/)
		.filter((w) => canonicalOverride(w) === null)
		.join(" ")
		.trim();
}

// ── Layered merge ──────────────────────────────────────────────────────────

/** Map an agent's `settings` block into a TurnConfig. */
function fromFrontmatter(def: AgentDefinition): TurnConfig {
	const s = def.settings;
	const out: TurnConfig = {};

	if (s.provider !== undefined) out.provider = s.provider;
	if (s.modelTier !== undefined) out.modelTier = s.modelTier;

	if (s.voice === "on") out.forceVoice = true;
	else if (s.voice === "off") out.suppressVoice = true;

	if (s.temp === "cold") out.temperaturePreset = "cold";
	else if (s.temp === "hot") out.temperaturePreset = "hot";

	if (s.topP === "creative") out.topPPreset = "creative";
	else if (s.topP === "rigid") out.topPPreset = "rigid";

	if (s.reasoningEffort === "low") out.reasoningEffort = "low";
	else if (s.reasoningEffort === "high") out.reasoningEffort = "high";

	if (s.stepLimit !== undefined) out.stepLimit = s.stepLimit;
	if (s.historyLimit !== undefined) out.historyLimit = s.historyLimit;
	if (s.historyScope !== undefined) out.historyScope = s.historyScope;
	if (s.showTrace !== undefined) out.showTrace = s.showTrace;
	if (s.report !== undefined) out.report = s.report;
	if (s.vault !== undefined) out.vault = s.vault;

	return out;
}

/** Resolve a parsed-overrides map into a TurnConfig by merging recognised presets. */
function resolveOverrides(active: Record<string, boolean>): TurnConfig {
	const out: TurnConfig = {};
	for (const [name, on] of Object.entries(active)) {
		if (!on) continue;
		const def = overrideRegistry.get(name);
		if (!def) continue;
		Object.assign(out, def.overrides);
	}
	return out;
}

/**
 * Read-through of global defaults into a TurnConfig fragment. Per-agent
 * settings carry their own enum defaults like `voice: "auto"` so
 * `fromFrontmatter` always wins for those — globalDefaults here only sets
 * fields the per-agent layer leaves undefined (currently: `provider`,
 * `modelTier`).
 */
function fromGlobalDefaults(): TurnConfig {
	return {
		provider: settings.defaultProvider,
		modelTier: settings.agentDefaults.modelTier,
	};
}

/**
 * Layered build: globalDefaults → agent settings → per-message overrides.
 * Per-message wins. `!voice` always clears `suppressVoice` (UX guarantee).
 *
 * `vault` map is deep-merged across the three layers (later keys win) so a
 * global wildcard like `{"*":"read"}` survives a per-agent `{"Training":"full"}`.
 */
export function buildTurnConfig(
	def: AgentDefinition,
	active: Record<string, boolean>,
): TurnConfig {
	const presets = resolveOverrides(active);
	const merged: TurnConfig = {
		...fromGlobalDefaults(),
		...fromFrontmatter(def),
		...presets,
	};

	const vaultMap: Record<string, AgentVaultEntry> = {
		...(settings.agentDefaults.vault ?? {}),
		...(def.settings.vault ?? {}),
		...(presets.vault ?? {}),
	};
	if (Object.keys(vaultMap).length > 0) merged.vault = vaultMap;

	if (presets.forceVoice) merged.suppressVoice = false;

	// Sim is a superset of ghost: never persist user-msg or assistant trace.
	// Pinning ghost here means every existing `if (config.ghost)` site honours it.
	if (merged.simulate) {
		merged.ghost = true;
		merged.skipHistory = true;
	}
	return merged;
}
