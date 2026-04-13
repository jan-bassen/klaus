import { z } from "zod";
import { log } from "@/logger";
import { modelTiers } from "@/settings";

/** Typed overrides that flags produce — consumed by pipeline and agent. */
export interface FlagOverrides {
	/** Force TTS output on reply tool. */
	forceVoice?: boolean;
	/** Skip conversation history. */
	skipHistory?: boolean;
	/** Override model tier for this turn. */
	modelTier?: (typeof modelTiers)[number];
	/** Override provider for this turn (e.g. "claude", "chatgpt", "gemini"). */
	provider?: string;
	/** Auto-accept confirmation prompts (vault permissions + tool confirmations). */
	autoAccept?: boolean;
	/** Temperature preset — resolved per-provider in agent.ts. */
	temperaturePreset?: "cold" | "hot";
	/** TopP preset — resolved per-provider in agent.ts. */
	topPPreset?: "creative" | "rigid";
	/** Tool choice constraint: "none" disables tools, "required" forces tool use. */
	toolChoice?: "none" | "required";
	/** Suppress voice output even when agent requests it. */
	suppressVoice?: boolean;
	/** Ephemeral call — skip all persistence. */
	ghost?: boolean;
	/** Reasoning effort preset — resolved per-provider in agent.ts. */
	reasoningEffort?: "low" | "high";
	/** Fast inference mode — resolved per-provider in agent.ts. */
	fast?: boolean;
}

/** Describes a single flag's metadata and overrides. */
export interface FlagDef {
	name: string;
	aliases?: string[];
	description: string;
	overrides: FlagOverrides;
}

// ── Zod schemas ──────────────────────────────────────────────────────

const FlagOverridesSchema = z
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

const FlagDefShape = z
	.object({
		name: z.string(),
		description: z.string(),
		overrides: z.record(z.unknown()),
	})
	.passthrough();

function isFlagDef(x: unknown): x is FlagDef {
	return FlagDefShape.safeParse(x).success;
}

// ── Registry ─────────────────────────────────────────────────────────

/** Map for O(1) lookup — indexes both canonical names and aliases. */
export const flagRegistry = new Map<string, FlagDef>();

function registerFlag(def: FlagDef): void {
	const parsed = FlagOverridesSchema.safeParse(def.overrides);
	if (!parsed.success) {
		log.warn("[flags] invalid overrides, skipping flag", {
			name: def.name,
			error: parsed.error.message,
		});
		return;
	}
	flagRegistry.set(def.name, def);
	if (def.aliases) {
		for (const alias of def.aliases) flagRegistry.set(alias, def);
	}
	log.debug("[flags] registered", { name: def.name });
}

/** Returns all known flag names and aliases. */
export function getKnownFlags(): string[] {
	return [...flagRegistry.keys()];
}

// ── Loader ───────────────────────────────────────────────────────────

/** Load all flag .ts files from a directory. Called at startup. */
export async function loadFlags(flagsDir: string): Promise<void> {
	flagRegistry.clear();
	const glob = new Bun.Glob("*.ts");
	for await (const file of glob.scan({ cwd: flagsDir })) {
		if (file === "index.ts") continue;
		try {
			const mod = (await import(`${flagsDir}/${file}`)) as Record<
				string,
				unknown
			>;
			for (const exported of Object.values(mod)) {
				if (isFlagDef(exported)) registerFlag(exported);
			}
		} catch (err) {
			log.warn("[flags] failed to load flag file", {
				file,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

// ── Parsing (merged from whatsapp/flags.ts) ──────────────────────────

/** Returns the canonical flag name if a token is a recognized !flag or alias, otherwise null. */
function flagName(token: string): string | null {
	if (!token.startsWith("!") || token.length <= 1) return null;
	const def = flagRegistry.get(token.slice(1));
	return def ? def.name : null;
}

/** Parse !flags from a message and return the active flags. */
export function parseFlags(msg: { text?: string }): Record<string, boolean> {
	if (!msg.text) return {};

	const flags: Record<string, boolean> = {};
	for (const token of msg.text.split(/\s+/)) {
		const name = flagName(token);
		if (name) flags[name] = true;
	}
	return flags;
}

/** Remove recognized !flag tokens from text and collapse whitespace. */
export function stripFlags(text: string): string {
	return text
		.split(/\s+/)
		.filter((token) => flagName(token) === null)
		.join(" ")
		.trim();
}

// ── Resolution ───────────────────────────────────────────────────────

/** Resolve parsed flags into typed overrides by merging the overrides maps. */
export function resolveOverrides(
	flags: Record<string, boolean>,
): FlagOverrides {
	const result: FlagOverrides = {};
	for (const [name, active] of Object.entries(flags)) {
		if (!active) continue;
		const def = flagRegistry.get(name);
		if (!def) continue;
		Object.assign(result, def.overrides);
	}
	return result;
}
