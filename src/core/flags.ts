import type { ModelTier } from "@/settings";

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
	| "creative"
	| "rigid"
	| "no-tools"
	| "use-tools"
	| "ghost"
	| "claude"
	| "chatgpt"
	| "gemini"
	| "low"
	| "high"
	| "fast";

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
	/** Ephemeral call — skip all persistence. */
	ghost?: boolean;
	/** Reasoning effort preset — resolved per-provider in agent.ts. */
	reasoningEffort?: "low" | "high";
	/** Fast inference mode — resolved per-provider in agent.ts. */
	fast?: boolean;
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
	{ name: "creative", description: "Use high topP (diverse sampling)" },
	{ name: "rigid", description: "Use low topP (focused sampling)" },
	{ name: "no-tools", description: "Disable all tools except reply" },
	{ name: "use-tools", description: "Force tool use (model must call a tool)" },
	{ name: "ghost", description: "Ephemeral call — no history, auto-delete" },
	{ name: "low", description: "Low reasoning effort (faster, cheaper)" },
	{
		name: "high",
		description: "High reasoning effort (slower, more thorough)",
	},
	{ name: "fast", description: "Fast inference mode (provider-dependent)" },
	{ name: "claude", description: "Use Claude provider for this turn" },
	{ name: "chatgpt", description: "Use ChatGPT provider for this turn" },
	{ name: "gemini", description: "Use Gemini provider for this turn" },
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
	if (flags.small) overrides.modelTier = "small";
	if (flags.medium) overrides.modelTier = "medium";
	if (flags.large) overrides.modelTier = "large";
	if (flags.accept) overrides.autoAccept = true;
	if (flags.cold) overrides.temperaturePreset = "cold";
	if (flags.hot) overrides.temperaturePreset = "hot";
	if (flags.creative) overrides.topPPreset = "creative";
	if (flags.rigid) overrides.topPPreset = "rigid";
	if (flags["no-tools"]) overrides.toolChoice = "none";
	if (flags["use-tools"]) overrides.toolChoice = "required";
	if (flags.ghost) {
		overrides.ghost = true;
		overrides.skipHistory = true;
	}
	if (flags.low) overrides.reasoningEffort = "low";
	if (flags.high) overrides.reasoningEffort = "high";
	if (flags.fast) overrides.fast = true;
	if (flags.claude) overrides.provider = "claude";
	if (flags.chatgpt) overrides.provider = "chatgpt";
	if (flags.gemini) overrides.provider = "gemini";
	return overrides;
}
