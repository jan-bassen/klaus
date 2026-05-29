import { settings } from "../../infra/config.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import {
	clearNextPrefix,
	getNextPrefix,
	setNextPrefix,
} from "../../pipeline/next.ts";
import type { Command } from "./index.ts";

function send(msg: InboundMessage, content: string, suffix: string): void {
	enqueueMessage({
		chatId: msg.chatId,
		content,
		dedupKey: `${msg.id}:${suffix}`,
		label: settings.whatsapp.systemLabel,
	});
}

export const nextCommand: Command = {
	name: "next",
	aliases: ["n"],
	params: [{ name: "prefix" }],
	description: "Prepend text to the next non-command message",
	execute(msg: InboundMessage, args: string[]): Promise<void> {
		const input = args.join(" ").trim();

		if (!input) {
			const current = getNextPrefix(msg.chatId);
			send(
				msg,
				current ? `Next prefix: ${current}` : "No next prefix is set.",
				"next-show",
			);
			return Promise.resolve();
		}

		if (input.toLowerCase() === "cancel") {
			const cleared = clearNextPrefix(msg.chatId);
			send(
				msg,
				cleared ? "Next prefix cleared." : "No next prefix was set.",
				"next-clear",
			);
			return Promise.resolve();
		}

		setNextPrefix(msg.chatId, input);
		send(msg, `Next prefix set: ${input}`, "next-set");
		return Promise.resolve();
	},
};
