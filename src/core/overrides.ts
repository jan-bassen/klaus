import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { log } from "@/logger";
import { modelTiers, settings } from "@/settings";
import type { AgentDefinition } from "@/types";

// ── overrides interface ────────────────────────────────────────────────

/** Typed overrides consumed by pipeline and agent. */
export interface overrides {
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
}

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
	.strict();

// ── override definition ────────────────────────────────────────────────

/** A named preset that maps a !name to an overrides map. */
export interface overrideDef {
	name: string;
	aliases?: string[];
	description: string;
	overrides: overrides;
}

const overrideDefShape = z
	.object({
		name: z.string(),
		description: z.string(),
		overrides: z.record(z.unknown()),
	})
	.passthrough();

// ── YAML entry schema ──────────────────────────────────────────────────

const YamlEntrySchema = z.object({
	aliases: z.array(z.string()).optional(),
	description: z.string(),
	overrides: overridesSchema,
});

const YamlFileSchema = z.record(z.string(), YamlEntrySchema);

// ── Registry ────────────────────────────────────────────────────────────

/** Map for O(1) lookup — indexes both canonical names and aliases. */
export const overrideRegistry = new Map<string, overrideDef>();

function registeroverride(def: overrideDef): void {
	overrideRegistry.set(def.name, def);
	if (def.aliases) {
		for (const alias of def.aliases) overrideRegistry.set(alias, def);
	}
	log.debug("[overrides] registered", { name: def.name });
}

/** Returns all known override preset names and aliases. */
export function getKnownoverrides(): string[] {
	return [...overrideRegistry.keys()];
}

// ── Loader ──────────────────────────────────────────────────────────────

/** Load override presets from a YAML file. Called at startup and on hot-reload. */
export async function loadoverrides(yamlPath?: string): Promise<void> {
	overrideRegistry.clear();
	const filePath = yamlPath ?? `${settings.vault.internalPath}/overrides.yaml`;

	let raw: string;
	try {
		raw = await Bun.file(filePath).text();
	} catch {
		log.warn("[overrides] overrides.yaml not found, no presets loaded", {
			path: filePath,
		});
		return;
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err) {
		log.warn("[overrides] failed to parse overrides.yaml", {
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	const result = YamlFileSchema.safeParse(parsed);
	if (!result.success) {
		log.warn("[overrides] invalid overrides.yaml schema", {
			error: result.error.message,
		});
		return;
	}

	for (const [name, entry] of Object.entries(result.data)) {
		registeroverride({
			name,
			...(entry.aliases ? { aliases: entry.aliases } : {}),
			description: entry.description,
			overrides: entry.overrides as overrides,
		});
	}

	log.info("[overrides] loaded presets", {
		count: new Set([...overrideRegistry.values()]).size,
	});
}

// ── Parsing ─────────────────────────────────────────────────────────────

/** Returns the canonical override name if a token is a recognized !preset or alias, otherwise null. */
function overrideName(token: string): string | null {
	if (!token.startsWith("!") || token.length <= 1) return null;
	const def = overrideRegistry.get(token.slice(1));
	return def ? def.name : null;
}

/** Parse !overrides from a message and return the active presets. */
export function parseoverrides(msg: {
	text?: string;
}): Record<string, boolean> {
	if (!msg.text) return {};

	const active: Record<string, boolean> = {};
	for (const token of msg.text.split(/\s+/)) {
		const name = overrideName(token);
		if (name) active[name] = true;
	}
	return active;
}

/** Remove recognized !override tokens from text and collapse whitespace. */
export function stripoverrides(text: string): string {
	return text
		.split(/\s+/)
		.filter((token) => overrideName(token) === null)
		.join(" ")
		.trim();
}

// ── Resolution ──────────────────────────────────────────────────────────

/** Resolve parsed presets into typed overrides by merging the overrides maps. */
export function resolveoverrides(active: Record<string, boolean>): overrides {
	const result: overrides = {};
	for (const [name, on] of Object.entries(active)) {
		if (!on) continue;
		const def = overrideRegistry.get(name);
		if (!def) continue;
		Object.assign(result, def.overrides);
	}
	return result;
}

// ── Agent defaults ──────────────────────────────────────────────────────

/** override keys that can appear directly in agent frontmatter as defaults. */
const override_KEYS: readonly (keyof overrides)[] = [
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
	presetoverrides: overrides,
	def: AgentDefinition,
): overrides {
	const agentDefaults: overrides = {};

	// Extract override fields from agent frontmatter
	for (const key of override_KEYS) {
		const value = (def as Record<string, unknown>)[key];
		if (value !== undefined) {
			(agentDefaults as Record<string, unknown>)[key] = value;
		}
	}

	// provider and modelTier are already first-class frontmatter fields
	if (def.provider !== undefined) agentDefaults.provider = def.provider;

	// Merge: per-message overrides win over agent defaults
	const result = { ...agentDefaults, ...presetoverrides };

	// Special case: !voice always clears suppressVoice
	if (presetoverrides.forceVoice) {
		result.suppressVoice = false;
	}

	return result;
}

// ── Template vars ──────────────────────────────────────────────────────

/** Compute the flat template vars available in all Handlebars templates (agent prompts, snippets). */
export function buildTemplateVars(
	ov: overrides,
	agent: AgentDefinition,
): Record<string, unknown> {
	return {
		...ov,
		provider: agent.provider ?? "default",
		isVoiceOn: !!ov.forceVoice,
		isVoiceOff: !!ov.suppressVoice,
		isVoiceAuto: !ov.forceVoice && !ov.suppressVoice,
	};
}
