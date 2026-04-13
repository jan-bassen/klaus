import type { Command } from "@/commands";
import { getDefaultAgent } from "@/core/defaults";
import { getActiveJobs } from "@/core/queue";
import { settings } from "@/settings";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

export const statusCommand: Command = {
	name: "status",
	aliases: ["s"],
	description: "Show current agent and system status",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		try {
			const jobs = await getActiveJobs();
			const agent = getDefaultAgent(msg.chatId);

			enqueueMessage({
				chatId: msg.chatId,
				content: `*Klaus status*\nAgent: @${agent}\nJobs: ${jobs.length} active`,
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
