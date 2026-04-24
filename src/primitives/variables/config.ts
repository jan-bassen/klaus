import type { Variable } from "@/primitives/variables";

/**
 * Effective configuration for this turn — agent frontmatter defaults merged
 * with any per-message overrides — plus derived convenience flags (voice
 * mode, etc.). Templates consume this without caring about provenance.
 */
export const configVariable: Variable = {
	key: "config",
	description: "Effective turn config (voice mode, provider, model, flags)",
	async run(turn) {
		const cfg = turn.config;
		return {
			...cfg,
			isVoiceOn: !!cfg.forceVoice,
			isVoiceOff: !!cfg.suppressVoice,
			isVoiceAuto: !cfg.forceVoice && !cfg.suppressVoice,
		};
	},
};
