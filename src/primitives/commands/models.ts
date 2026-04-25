import { type ModelTier, resolveProvider, settings } from "@/infra/config";
import type { InboundMessage } from "@/infra/whatsapp/receive";
import { enqueueMessage } from "@/infra/whatsapp/send";
import { agentRegistry, getDefaultAgent } from "@/pipeline/agents";
import type { Command } from "@/primitives/commands";

const TIERS: ModelTier[] = ["small", "medium", "large"];

export const modelsCommand: Command = {
	name: "models",
	description: "List the configured model tiers",
	async execute(msg: InboundMessage): Promise<void> {
		const agentName = getDefaultAgent(msg.chatId);
		const def = agentRegistry.get(agentName);
		const currentTier =
			def?.settings.modelTier ?? settings.agentDefaults.modelTier;

		const { config: cfg } = resolveProvider();
		const lines: string[] = [`provider: ${cfg.baseURL}`];
		for (const tier of TIERS) {
			const marker = tier === currentTier ? " ← current" : "";
			lines.push(`  ${tier}: ${cfg[tier]}${marker}`);
		}

		enqueueMessage({
			chatId: msg.chatId,
			content: lines.join("\n"),
			dedupKey: `${msg.id}:models`,
			label: settings.whatsapp.systemLabel,
		});
	},
};
