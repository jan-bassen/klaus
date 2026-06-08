import { z } from "zod";
import { log } from "../../infra/logger.ts";
import { appendReaction } from "../../infra/store/history.ts";
import { getSocket } from "../../infra/whatsapp/connection.ts";
import { type MessageKey, sendReaction } from "../../infra/whatsapp/send.ts";
import { SET_REACTION_TOOL_NAME } from "./core.ts";
import type { ToolDefinition } from "./index.ts";

const reactSchema = z.object({
	emoji: z
		.string()
		.describe(
			'Emoji to react with (e.g. "👍"). Pass an empty string to remove the reaction.',
		),
	messageLabel: z
		.number({
			error: "messageLabel must be an integer message label, not a string.",
		})
		.int({
			error: "messageLabel must be an integer message label, not a string.",
		})
		.nonnegative({
			error:
				"messageLabel must be 0 for the current message or a positive visible message label.",
		})
		.optional()
		.describe(
			"Visible message label to react to. Use 0 or omit for the current message, or the positive integer from a history ref like 'ref #3'.",
		),
});

export const setReactionTool: ToolDefinition<typeof reactSchema> = {
	name: SET_REACTION_TOOL_NAME,
	description:
		'Set an emoji reaction on a WhatsApp message. Use for lightweight acknowledgements. Pass "" to remove a reaction.',
	inputSchema: reactSchema,
	execute: async ({ emoji, messageLabel }, context) => {
		if (!context.message) return { error: "No inbound message to react to" };
		const chatId = context.chatId;

		let externalId: string;
		let key: MessageKey;

		if (messageLabel !== undefined && messageLabel !== 0) {
			const ref = context.messageRefs?.[String(messageLabel)];
			if (!ref) return { error: `Unknown message label: #${messageLabel}` };
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
