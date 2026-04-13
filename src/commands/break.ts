import type { Command } from "@/commands";
import { settings } from "@/config";
import { appendBreak } from "@/store/conversation";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

export const breakCommand: Command = {
	name: "break",
	aliases: ["b"],
	description: "Insert a context break — fresh start from here",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		await appendBreak();
		enqueueMessage({
			chatId: msg.chatId,
			content: "Context break. Fresh start from here.",
			dedupKey: `${msg.id}:break`,
			label: settings.whatsapp.systemLabel,
		});
	},
};
