import type { WAMessageKey } from "@whiskeysockets/baileys";
import { z } from "zod";
import { log } from "@/logger";
import { appendReaction } from "@/store/conversation";
import type { ToolDefinition } from "@/types";
import { getSocket } from "@/whatsapp/connection";
import { sendReaction } from "@/whatsapp/reactions";

const reactSchema = z.object({
	emoji: z
		.string()
		.describe(
			'Emoji to react with (e.g. "👍"). Pass an empty string to remove the reaction.',
		),
	messageRef: z
		.string()
		.optional()
		.describe(
			'Message label from conversation history (e.g. "3") or "current". Defaults to the current message.',
		),
});

export const reactTool: ToolDefinition<typeof reactSchema> = {
	name: "react",
	description:
		'React to a message with an emoji. Use for lightweight acknowledgements — e.g. 👍 to confirm, ✅ on task done, ❤️ for appreciation. Pass "" to remove. Use messageRef to react to an older message from the conversation history.',
	inputSchema: reactSchema,
	execute: async ({ emoji, messageRef }, context) => {
		if (!context.message) return { error: "No inbound message to react to" };
		const chatId = context.chatId;

		let externalId: string;
		let key: WAMessageKey;

		if (messageRef && messageRef !== "current") {
			const refs = context.assembled?.vars?._messageRefs as
				| Record<string, { externalId: string; role: string }>
				| undefined;
			const ref = refs?.[messageRef];
			if (!ref) return { error: `Unknown message reference: #${messageRef}` };
			externalId = ref.externalId;
			key = { remoteJid: chatId, fromMe: ref.role !== "user", id: externalId };
		} else {
			externalId = context.message.id;
			key = context.message.messageKey as WAMessageKey;
		}

		const result = await sendReaction(chatId, key, emoji);
		if (result instanceof Error) {
			log.warn("[react] sendReaction failed", {
				chatId,
				error: result.message,
			});
			return { error: result.message };
		}
		const botId = getSocket().user?.id ?? "bot";
		await appendReaction({
			messageExternalId: externalId,
			emoji,
			senderId: botId,
			fromMe: true,
		});
		return "reacted";
	},
	kind: "builtin",
	capability: "tool",
};
