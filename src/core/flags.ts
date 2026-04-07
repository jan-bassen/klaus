import type { ModelTier } from "@/settings";
import { settings } from "@/settings";

/** All known flag names as a union type. */
export type FlagName =
	| "voice"
	| "clean"
	| "small"
	| "medium"
	| "large"
	| "accept"
	| "cold"
	| "hot"
	| "no-tools"
	| "use-tools"
	| "ghost";

/** Describes a single flag's metadata. */
export interface FlagDef {
	name: FlagName;
	description: string;
}

/** Typed overrides that flags produce — consumed by pipeline and agent. */
export interface FlagOverrides {
	/** Force TTS output on reply tool. */
	forceVoice?: boolean;
	/** Skip conversation history. */
	skipHistory?: boolean;
	/** Override model tier for this turn. */
	modelTier?: ModelTier;
	/** Auto-accept confirmation prompts (vault permissions + tool confirmations). */
	autoAccept?: boolean;
	/** Override temperature for this turn. */
	temperature?: number;
	/** Tool choice constraint: "none" disables tools, "required" forces tool use. */
	toolChoice?: "none" | "required";
	/** Ephemeral call — skip all persistence. */
	ghost?: boolean;
}

/** Static registry of all flags. */
export const FLAG_DEFS: readonly FlagDef[] = [
	{ name: "voice", description: "Reply as a voice message (TTS)" },
	{ name: "clean", description: "Call without conversation history" },
	{ name: "small", description: "Use low-tier model" },
	{ name: "medium", description: "Use default-tier model" },
	{ name: "large", description: "Use high-tier model" },
	{ name: "accept", description: "Auto-accept confirmation prompts" },
	{ name: "cold", description: "Set temperature to low (deterministic)" },
	{ name: "hot", description: "Set temperature to high (creative)" },
	{ name: "no-tools", description: "Disable all tools except reply" },
	{ name: "use-tools", description: "Force tool use (model must call a tool)" },
	{ name: "ghost", description: "Ephemeral call — no history, auto-delete" },
] as const;

/** Map for O(1) lookup — replaces the old mutable file-loaded registry. */
export const flagRegistry = new Map<string, FlagDef>(
	FLAG_DEFS.map((f) => [f.name, f]),
);

/** Returns all known flag names. */
export function getKnownFlags(): string[] {
	return FLAG_DEFS.map((f) => f.name);
}

/** Resolve parsed flags into typed overrides for the pipeline. */
export function resolveOverrides(
	flags: Record<string, boolean>,
): FlagOverrides {
	const overrides: FlagOverrides = {};
	if (flags.voice) overrides.forceVoice = true;
	if (flags.clean) overrides.skipHistory = true;
	if (flags.small) overrides.modelTier = "low";
	if (flags.medium) overrides.modelTier = "default";
	if (flags.large) overrides.modelTier = "high";
	if (flags.accept) overrides.autoAccept = true;
	if (flags.cold) overrides.temperature = settings.llm.coldTemperature;
	if (flags.hot) overrides.temperature = settings.llm.hotTemperature;
	if (flags["no-tools"]) overrides.toolChoice = "none";
	if (flags["use-tools"]) overrides.toolChoice = "required";
	if (flags.ghost) {
		overrides.ghost = true;
		overrides.skipHistory = true;
	}
	return overrides;
}
