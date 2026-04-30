import { settings } from "../../infra/config.ts";
import { appendBreak } from "../../infra/store/history.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import type { Command } from "./index.ts";

export const breakCommand: Command = {
	name: "break",
	aliases: ["b"],
	description: "Insert a context break",
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
