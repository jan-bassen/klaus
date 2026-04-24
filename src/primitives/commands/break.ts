import { settings } from "@/infra/config";
import { appendBreak } from "@/infra/store/history";
import { enqueueMessage } from "@/infra/whatsapp/send";
import type { Command } from "@/primitives/commands";
import type { InboundMessage } from "@/infra/whatsapp/receive";

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
