import {
	getProviderNames,
	type ModelTier,
	resolveProvider,
	settings,
} from "@/infra/config";
import { enqueueMessage } from "@/infra/whatsapp/send";
import { agentRegistry, getDefaultAgent } from "@/pipeline/agents";
import type { Command } from "@/primitives/commands";
import type { InboundMessage } from "@/infra/whatsapp/receive";

const TIERS: ModelTier[] = ["small", "medium", "large"];

export const modelsCommand: Command = {
	name: "models",
	description: "List all configured providers and their models",
	async execute(msg: InboundMessage): Promise<void> {
		const agentName = getDefaultAgent(msg.chatId);
		const def = agentRegistry.get(agentName);
		const activeName = def?.settings.provider ?? getProviderNames()[0];
		const currentTier = def?.settings.modelTier;

		const names = getProviderNames();
		const lines: string[] = [];

		for (const name of names) {
			const cfg = resolveProvider(name);
			const isActive = name === activeName;
			const header = isActive ? `*${name}* (active)` : name;
			lines.push(header);
			for (const tier of TIERS) {
				const marker = isActive && tier === currentTier ? " ← current" : "";
				lines.push(`  ${tier}: ${cfg[tier]}${marker}`);
			}
		}

		enqueueMessage({
			chatId: msg.chatId,
			content: lines.join("\n"),
			dedupKey: `${msg.id}:models`,
			label: settings.whatsapp.systemLabel,
		});
	},
};
