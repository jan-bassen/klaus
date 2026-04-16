import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { modelTiers, settings } from "@/config";
import { log } from "@/logger";
import type { AgentDefinition } from "@/types";

// ── TurnConfig ─────────────────────────────────────────────────────────

/**
 * Effective turn configuration — agent frontmatter defaults merged with
 * per-message override presets. Consumed by the pipeline, runner, and the
 * `config` variable; templates read this via `{{config.*}}`.
 */
export interface TurnConfig {
	forceVoice?: boolean;
	skipHistory?: boolean;
	modelTier?: (typeof modelTiers)[number];
	provider?: string;
	autoAccept?: boolean;
	temperaturePreset?: "cold" | "hot";
	topPPreset?: "creative" | "rigid";
	toolChoice?: "none" | "required";
	suppressVoice?: boolean;
	ghost?: boolean;
	reasoningEffort?: "low" | "high";
	fast?: boolean;
	[key: string]: unknown;
}

/** Validation schema for the `overrides:` map inside a preset entry in overrides.yml. */
export const overridesSchema = z
	.object({
		forceVoice: z.boolean().optional(),
		skipHistory: z.boolean().optional(),
		modelTier: z.enum(modelTiers).optional(),
		provider: z.string().optional(),
		autoAccept: z.boolean().optional(),
		temperaturePreset: z.enum(["cold", "hot"]).optional(),
		topPPreset: z.enum(["creative", "rigid"]).optional(),
		toolChoice: z.enum(["none", "required"]).optional(),
		suppressVoice: z.boolean().optional(),
		ghost: z.boolean().optional(),
		reasoningEffort: z.enum(["low", "high"]).optional(),
		fast: z.boolean().optional(),
	})
	.passthrough();

// ── Override preset definition ─────────────────────────────────────────

/** A named preset that maps a `!name` to a partial TurnConfig. */
export interface OverrideDef {
	name: string;
	aliases?: string[];
	description: string;
	overrides: TurnConfig;
}

// ── YAML entry schema ──────────────────────────────────────────────────

const YamlEntrySchema = z.object({
	aliases: z.array(z.string()).optional(),
	description: z.string(),
	overrides: overridesSchema,
});

const YamlFileSchema = z.record(z.string(), YamlEntrySchema);

// ── Registry ────────────────────────────────────────────────────────────

/** Map for O(1) lookup — indexes both canonical names and aliases. */
export const overrideRegistry = new Map<string, OverrideDef>();

function registerOverride(def: OverrideDef): void {
	overrideRegistry.set(def.name, def);
	if (def.aliases) {
		for (const alias of def.aliases) overrideRegistry.set(alias, def);
	}
	log.debug(`[overrides] registered: ${def.name}`);
}

/** Returns all known override preset names and aliases. */
export function getKnownOverrides(): string[] {
	return [...overrideRegistry.keys()];
}

// ── Loader ──────────────────────────────────────────────────────────────

/** Load override presets from a YAML file. Called at startup and on hot-reload. */
export async function loadOverrides(yamlPath?: string): Promise<void> {
	overrideRegistry.clear();
	const filePath = yamlPath ?? `${settings.vault.internalPath}/overrides.yml`;

	let raw: string;
	try {
		raw = await Bun.file(filePath).text();
	} catch {
		log.warn("[overrides] overrides.yml not found, no presets loaded");
		return;
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err) {
		log.warn("[overrides] failed to parse overrides.yml", {
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	const result = YamlFileSchema.safeParse(parsed);
	if (!result.success) {
		log.warn("[overrides] invalid overrides.yml schema", {
			error: result.error.message,
		});
		return;
	}

	for (const [name, entry] of Object.entries(result.data)) {
		registerOverride({
			name,
			...(entry.aliases ? { aliases: entry.aliases } : {}),
			description: entry.description,
			overrides: entry.overrides as TurnConfig,
		});
	}

	const count = new Set([...overrideRegistry.values()]).size;
	log.info(`[overrides] loaded ${count} presets`);
}

// ── Parsing ─────────────────────────────────────────────────────────────

/** Returns the canonical override name if a word is a recognized !preset or alias, otherwise null. */
function overrideName(word: string): string | null {
	if (!word.startsWith("!") || word.length <= 1) return null;
	const def = overrideRegistry.get(word.slice(1));
	return def ? def.name : null;
}

/** Parse `!preset` words from a message and return the active preset names. */
export function parseOverrides(msg: {
	text?: string;
}): Record<string, boolean> {
	if (!msg.text) return {};

	const active: Record<string, boolean> = {};
	for (const word of msg.text.split(/\s+/)) {
		const name = overrideName(word);
		if (name) active[name] = true;
	}
	return active;
}

/** Remove recognized `!preset` words from text and collapse whitespace. */
export function stripOverrides(text: string): string {
	return text
		.split(/\s+/)
		.filter((w) => overrideName(w) === null)
		.join(" ")
		.trim();
}

// ── Resolution ──────────────────────────────────────────────────────────

/** Resolve parsed presets into a single TurnConfig by merging their override maps. */
export function resolveOverrides(active: Record<string, boolean>): TurnConfig {
	const result: TurnConfig = {};
	for (const [name, on] of Object.entries(active)) {
		if (!on) continue;
		const def = overrideRegistry.get(name);
		if (!def) continue;
		Object.assign(result, def.overrides);
	}
	return result;
}

// ── Agent defaults ──────────────────────────────────────────────────────

/** Keys that can appear directly in agent frontmatter as defaults. */
const AGENT_DEFAULT_KEYS: readonly (keyof TurnConfig)[] = [
	"forceVoice",
	"suppressVoice",
	"skipHistory",
	"autoAccept",
	"ghost",
	"temperaturePreset",
	"topPPreset",
	"toolChoice",
	"reasoningEffort",
	"fast",
] as const;

/**
 * Resolves agent-level frontmatter defaults, then merges per-message overrides on top.
 * Per-message overrides always take precedence.
 */
export function resolveAgentDefaults(
	presetOverrides: TurnConfig,
	def: AgentDefinition,
): TurnConfig {
	const agentDefaults: TurnConfig = {};

	for (const key of AGENT_DEFAULT_KEYS) {
		const value = (def as Record<string, unknown>)[key];
		if (value !== undefined) {
			(agentDefaults as Record<string, unknown>)[key] = value;
		}
	}

	// provider and modelTier are first-class frontmatter fields
	if (def.provider !== undefined) agentDefaults.provider = def.provider;
	if (def.modelTier !== undefined) agentDefaults.modelTier = def.modelTier;

	// Merge: per-message overrides win over agent defaults
	const result = { ...agentDefaults, ...presetOverrides };

	// Special case: !voice always clears suppressVoice
	if (presetOverrides.forceVoice) {
		result.suppressVoice = false;
	}

	return result;
}
