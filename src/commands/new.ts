import type { Command } from "@/commands";
import { rotate } from "@/store/conversation";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

export const newCommand: Command = {
	name: "new",
	description: "Start a new conversation (rotates current history to archive)",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		await rotate();
		enqueueMessage({
			chatId: msg.chatId,
			content: "Conversation archived. Starting fresh.",
			dedupKey: `${msg.id}:new`,
		});
	},
};
