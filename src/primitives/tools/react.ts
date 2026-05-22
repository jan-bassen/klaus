import { z } from "zod";
import { log } from "../../infra/logger.ts";
import { appendReaction } from "../../infra/store/history.ts";
import { getSocket } from "../../infra/whatsapp/connection.ts";
import { type MessageKey, sendReaction } from "../../infra/whatsapp/send.ts";
import type { ToolDefinition } from "./index.ts";

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
		let key: MessageKey;

		if (messageRef && messageRef !== "current") {
			const ref = context.messageRefs?.[messageRef];
			if (!ref) return { error: `Unknown message reference: #${messageRef}` };
			externalId = ref.externalId;
			key = { remoteJid: chatId, fromMe: ref.role !== "user", id: externalId };
		} else {
			externalId = context.message.id;
			key = context.message.messageKey as MessageKey;
		}

		const result = await sendReaction(chatId, key, emoji);
		if (result instanceof Error) {
			log.warn("[send] reaction failed", {
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
			agent: context.agent.name,
			runId: context.runId,
		});
		return "reacted";
	},
	kind: "builtin",
	capability: "tool",
};
