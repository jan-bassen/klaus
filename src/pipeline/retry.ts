import path from "node:path";
import { agentRegistry, getDefaultAgent, loadAgentDefinition } from "@/agent";
import { runAgent } from "@/agent/runner";
import { settings } from "@/config";
import { assembleContext } from "@/context";
import { log } from "@/logger";
import { extractVarParams, mergeVarParams, readPromptBody } from "@/markdown";
import {
	type ConversationMessage,
	readAllMessages,
} from "@/store/conversation";
import type { InboundMessage, TurnContext } from "@/types";
import { startTyping, stopTyping } from "@/whatsapp/presence";
import { buildTemplateVars, resolveAgentDefaults } from "./overrides";

function agentsDir(): string {
	return settings.vault.agentsDir;
}

/**
 * Re-invoke the agent for a previously-persisted user message.
 *
 * The target message is treated as if it just arrived: a synthetic InboundMessage
 * is built from its stored content, a TurnContext is assembled, and runAgent()
 * is called directly. The target's existing conversation record is reused
 * (no re-persist) so superseded assistant responses and the new reply thread
 * naturally from the same user turn.
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

	const overrides = resolveAgentDefaults({}, def);
	const syntheticMsg: InboundMessage = {
		kind: "whatsapp",
		id: target.externalId,
		chatId,
		senderId: chatId,
		text: target.content ?? "",
		timestamp: new Date(target.createdAt),
		messageKey: { remoteJid: chatId, fromMe: false, id: target.externalId },
	};

	const partialTurn: Omit<TurnContext, "assembled"> = {
		chatId,
		message: syntheticMsg,
		agent: def,
		activeoverrides: {},
		overrides,
		templateVars: buildTemplateVars(overrides, def),
		messageId: target.id,
	};

	const promptBody = await readPromptBody(def.promptPath);
	const varParams = mergeVarParams(
		extractVarParams(promptBody, "hbs"),
		extractVarParams(syntheticMsg.text ?? "", "dollar"),
	);

	const assembled = await assembleContext(
		partialTurn,
		undefined,
		Object.keys(varParams).length > 0 ? varParams : undefined,
	);
	const turn: TurnContext = { ...partialTurn, assembled };

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
