import { settings } from "@/infra/config";
import { enqueueMessage } from "@/infra/whatsapp/send";
import { getDefaultAgent } from "@/pipeline/agents";
import type { Command } from "@/primitives/commands";
import type { InboundMessage } from "@/infra/whatsapp/receive";

export const statusCommand: Command = {
	name: "status",
	aliases: ["s"],
	description: "Show current agent and system status",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		try {
			const agent = getDefaultAgent(msg.chatId);

			enqueueMessage({
				chatId: msg.chatId,
				content: `*Klaus status*\nAgent: @${agent}`,
				dedupKey: `${msg.id}:status`,
				label: settings.whatsapp.systemLabel,
			});
		} catch {
			enqueueMessage({
				chatId: msg.chatId,
				content: "Status unavailable.",
				dedupKey: `${msg.id}:status-error`,
				label: settings.whatsapp.systemLabel,
			});
		}
	},
};
