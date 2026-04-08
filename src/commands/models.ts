import type { Command } from "@/commands";
import { agentRegistry } from "@/core/agent";
import { getDefaultAgent } from "@/core/defaults";
import { getActiveProvider, getProviderNames } from "@/core/provider-defaults";
import { type ModelTier, resolveProvider } from "@/settings";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

const TIERS: ModelTier[] = ["small", "medium", "large"];

export const modelsCommand: Command = {
	name: "models",
	description: "List all configured providers and their models",
	async execute(msg: InboundMessage): Promise<void> {
		const activeName = getActiveProvider(msg.chatId);
		const agentName = getDefaultAgent(msg.chatId);
		const def = agentRegistry.get(agentName);
		const currentTier = def?.modelTier;

		const names = getProviderNames();
		const lines: string[] = [];

		for (const name of names) {
			const cfg = resolveProvider(msg.chatId, name);
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
		});
	},
};
