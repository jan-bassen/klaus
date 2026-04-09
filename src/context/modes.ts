import { getProviderNames } from "@/settings";
import type { ContextVariable } from "@/types";

export const modesQuery: ContextVariable = {
	name: "modes",
	description: "Active agent modes (voice, accept, provider)",
	priority: -1,
	run: async (turn, _params) => {
		const def = turn.agent;
		const voice = def.voiceMode ?? "auto";
		const accept = def.acceptMode ?? "off";
		const provider = def.provider ?? getProviderNames()[0] ?? "default";
		const content = `Voice: ${voice} | Accept: ${accept} | Provider: ${provider}`;
		return {
			content,
			tokenCount: Math.ceil(content.length / 4),
			truncate: "never",
		};
	},
};
