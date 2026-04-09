import type { FlagOverrides } from "@/core/flags";
import type { AgentDefinition } from "@/types";

/**
 * Applies agent-level mode defaults to flag overrides.
 * Per-message flags always take precedence over mode defaults.
 */
export function applyModeDefaults(
	overrides: FlagOverrides,
	def: AgentDefinition,
): FlagOverrides {
	const result = { ...overrides };

	// Voice mode
	if (result.forceVoice) {
		// Explicit !voice flag — always wins, clear any suppression
		result.suppressVoice = false;
	} else if (def.voiceMode === "on") {
		result.forceVoice = true;
	} else if (def.voiceMode === "off") {
		result.suppressVoice = true;
	}

	// Accept mode
	if (result.autoAccept === undefined && def.acceptMode === "on") {
		result.autoAccept = true;
	}

	// Provider
	if (result.provider === undefined && def.provider) {
		result.provider = def.provider;
	}

	return result;
}
