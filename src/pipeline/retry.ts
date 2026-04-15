import path from "node:path";
import { agentRegistry, getDefaultAgent, loadAgentDefinition } from "@/agent";
import { runAgent } from "@/agent/runner";
import { settings } from "@/config";
import { log } from "@/logger";
import {
	type ConversationMessage,
	readAllMessages,
} from "@/store/conversation";
import type { InboundMessage, TurnContext } from "@/types";
import { assembleVariables } from "@/variables";
import { startTyping, stopTyping } from "@/whatsapp/presence";
import { resolveAgentDefaults } from "./overrides";

function agentsDir(): string {
	return settings.vault.agentsDir;
}

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

	const agentName = getDefaultAgent(chatId);
	let def = agentRegistry.get(agentName);
	if (!def) {
		const promptPath = path.join(agentsDir(), `${agentName}.md`);
		def = await loadAgentDefinition(promptPath);
		agentRegistry.set(def.name, def);
	}

	const config = resolveAgentDefaults({}, def);
	const syntheticMsg: InboundMessage = {
		kind: "whatsapp",
		id: target.externalId,
		chatId,
		senderId: chatId,
		text: target.content ?? "",
		timestamp: new Date(target.createdAt),
		messageKey: { remoteJid: chatId, fromMe: false, id: target.externalId },
	};

	const partialTurn: Omit<TurnContext, "vars"> = {
		chatId,
		message: syntheticMsg,
		agent: def,
		overrides: {},
		config,
		messageRefs: {},
		messageId: target.id,
	};

	const vars = await assembleVariables(partialTurn);
	const turn: TurnContext = { ...partialTurn, vars };

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
