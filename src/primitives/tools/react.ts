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
		.number({ error: "messageRef must be an integer label, not a string." })
		.int({ error: "messageRef must be an integer label, not a string." })
		.nonnegative({
			error:
				"messageRef must be 0 for the current message or a positive history label.",
		})
		.optional()
		.describe(
			"Integer message label to react to: 0 or omit for the current message, or a positive history label such as 3 for an older message.",
		),
});

export const reactTool: ToolDefinition<typeof reactSchema> = {
	name: "react",
	description:
		'React to a message with an emoji. Use for lightweight acknowledgements — e.g. 👍 to confirm, ✅ on task done, ❤️ for appreciation. Pass "" to remove. Omit messageRef for the current message; use a positive integer to react to an older numbered history message.',
	inputSchema: reactSchema,
	execute: async ({ emoji, messageRef }, context) => {
		if (!context.message) return { error: "No inbound message to react to" };
		const chatId = context.chatId;

		let externalId: string;
		let key: MessageKey;

		if (messageRef !== undefined && messageRef !== 0) {
			const ref = context.messageRefs?.[String(messageRef)];
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
};
