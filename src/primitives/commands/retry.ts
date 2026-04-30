import { settings } from "../../infra/config.ts";
import { getConversation } from "../../infra/store/history.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import { handleTurn } from "../../pipeline/index.ts";
import type { Command } from "./index.ts";

/**
 * Find the user message to retry.
 *
 * - If the /retry message quotes another message: target that user message
 *   (or the user message just before it, if a bot reply was quoted).
 * - Otherwise: target the user message before the most recent failed turn.
 */
async function selectTarget(
	msg: InboundMessage,
): Promise<{ text: string } | { error: string }> {
	const history = await getConversation();
	const quoted = msg.quotedMessage?.externalId;

	if (quoted) {
		const idx = history.findIndex((m) => m.externalId === quoted);
		if (idx === -1) {
			return { error: "Couldn't find the quoted message in recent history." };
		}
		const target = history[idx];
		if (!target) {
			return { error: "Couldn't find the quoted message in recent history." };
		}
		if (target.role === "user") {
			return target.content
				? { text: target.content }
				: { error: "That message has no text to retry." };
		}
		// Quoted an assistant message — walk back for the prior user message.
		for (let i = idx - 1; i >= 0; i--) {
			const m = history[i];
			if (m?.role === "user" && m.content) return { text: m.content };
		}
		return { error: "Couldn't find a user message to retry before that one." };
	}

	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i];
		if (m?.role !== "assistant" || !m.failed) continue;
		for (let j = i - 1; j >= 0; j--) {
			const u = history[j];
			if (u?.role === "user" && u.content) return { text: u.content };
		}
	}
	return {
		error:
			"Nothing to retry — no failed turn found. Quote a message to retry it.",
	};
}

export const retryCommand: Command = {
	name: "retry",
	aliases: ["r"],
	description: "Re-run the last failed turn",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		const target = await selectTarget(msg);
		if ("error" in target) {
			enqueueMessage({
				chatId: msg.chatId,
				content: target.error,
				dedupKey: `${msg.id}:retry-err`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		const replay: InboundMessage = {
			kind: "whatsapp",
			id: crypto.randomUUID(),
			chatId: msg.chatId,
			senderId: msg.senderId,
			text: target.text,
			timestamp: new Date(),
			messageKey: msg.messageKey,
		};
		await handleTurn(replay);
	},
};
