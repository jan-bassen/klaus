import { getDefaultAgent, getOrLoadAgent } from "@/agent/definitions";
import { runAgent } from "@/agent/runner";
import { buildTurn } from "@/agent/turn";
import { log } from "@/logger";
import {
	type ConversationMessage,
	readAllMessages,
} from "@/store/conversation";
import type { InboundMessage } from "@/types";
import { startTyping, stopTyping } from "@/whatsapp/presence";

/**
 * Re-invoke the agent for a previously-persisted user message.
 *
 * v1 limitation: retries run against the default agent and use stored text only.
 * Media, overrides, and @agent routing from the original turn are not reconstructed.
 */
export async function executeRetry(
	chatId: string,
	target: ConversationMessage,
): Promise<void> {
	if (!target.externalId) {
		throw new Error("Target message has no externalId — cannot retry");
	}

	const def = await getOrLoadAgent(getDefaultAgent(chatId));

	const syntheticMsg: InboundMessage = {
		kind: "whatsapp",
		id: target.externalId,
		chatId,
		senderId: chatId,
		text: target.content ?? "",
		timestamp: new Date(target.createdAt),
		messageKey: { remoteJid: chatId, fromMe: false, id: target.externalId },
	};

	const turn = await buildTurn({
		chatId,
		def,
		message: syntheticMsg,
		messageId: target.id,
	});

	log.info(`[retry] re-invoking @${def.name} for message ${target.id}`);
	await startTyping(chatId);
	try {
		await runAgent(turn, def);
	} finally {
		await stopTyping(chatId);
	}
}

/** Load the full conversation (respecting breaks & supersedes) for command lookups. */
export async function loadHistory(): Promise<ConversationMessage[]> {
	return readAllMessages();
}
