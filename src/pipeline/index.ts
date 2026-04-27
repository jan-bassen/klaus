/**
 * Inbound message orchestrator — single entry point for WhatsApp turns.
 *
 *   1. Auth (allowlist)
 *   2. Normalize + parse (STT, doc, links, commands, @agent, !overrides)
 *   3. Resolve agent + build effective config
 *   4. Persist message + resolve quoted media
 *   5. Execute agent (assemble context, prompts, run loop)
 */

import { formatUserError } from "@/errors";
import { settings, updateAllowedChatId } from "@/infra/config";
import { log } from "@/infra/logger";
import {
	findFileByExternalId,
	findFileByMessageId,
	updateFileMessageId,
} from "@/infra/store/files";
import {
	appendMessage,
	appendReaction,
	findByExternalId,
} from "@/infra/store/history";
import { getSocket, normalizeJid } from "@/infra/whatsapp/connection";
import {
	clearLoginFolder,
	clearSetupCode,
	getSetupCode,
} from "@/infra/whatsapp/login";
import { startTyping, stopTyping } from "@/infra/whatsapp/presence";
import type { InboundMessage } from "@/infra/whatsapp/receive";
import { enqueueMessage, sendReaction } from "@/infra/whatsapp/send";
import {
	agentRegistry,
	getDefaultAgent,
	getOrLoadAgent,
} from "@/pipeline/agents";
import { registry as commandRegistry } from "@/primitives/commands";
import { getVariables } from "@/primitives/variables";
import type { Trigger, TurnContext } from "./core";
import { executeAgent } from "./core";
import { parseMessage } from "./message";
import { buildTurnConfig } from "./overrides";

export interface AuthResult {
	allowed: boolean;
	setupMode?: boolean;
}

/** Verify the sender's chatId matches the configured allowedChatId. Fail-closed: unset blocks all. */
export function checkAllowlist(msg: InboundMessage): AuthResult {
	const allowed = settings.allowedChatId ?? "";
	if (allowed === "") {
		log.warn("[auth] no allowed chat configured, entering setup mode");
		return { allowed: false, setupMode: true };
	}
	if (msg.chatId !== allowed) {
		log.warn("[auth] rejected unauthorized chat");
		return { allowed: false };
	}
	return { allowed: true };
}

export async function handleTurn(msg: InboundMessage): Promise<void> {
	try {
		const auth = checkAllowlist(msg);
		if (!auth.allowed) {
			if (auth.setupMode) await handleSetupMode(msg);
			return;
		}

		const knownAgents = new Set(agentRegistry.keys());
		const parsed = await parseMessage(
			msg,
			knownAgents,
			settings.media.voice.stt.agentTriggers,
		);
		const processedMsg = parsed.msg;

		if (parsed.command) {
			log.info(`[pipeline] dispatching /${parsed.command.name} command`);
			await appendMessage({
				role: "user",
				content: processedMsg.text ?? null,
				externalId: processedMsg.id,
				command: parsed.command.name,
			});
			const command = commandRegistry.get(parsed.command.name);
			if (command) await command.execute(processedMsg, parsed.command.args);
			return;
		}

		const agentName = parsed.agent ?? getDefaultAgent(processedMsg.chatId);
		const def = await getOrLoadAgent(agentName);
		log.info(`[pipeline] routing to @${agentName}`);
		const config = buildTurnConfig(def, parsed.overrides);

		const effectiveMsg = resolveQuotedMedia(processedMsg);

		let messageId: string | undefined;
		if (!config.ghost) {
			const overrideNames = Object.keys(parsed.overrides);
			messageId = await appendMessage({
				role: "user",
				content: effectiveMsg.text ?? null,
				externalId: effectiveMsg.id,
				...(effectiveMsg.quotedMessage?.text
					? {
							quotedText: effectiveMsg.quotedMessage.text,
							quotedRole: "user",
						}
					: {}),
				...(overrideNames.length > 0 ? { overrides: overrideNames } : {}),
			});

			if (effectiveMsg.media?.fileId && messageId) {
				const backfill = await updateFileMessageId(
					effectiveMsg.media.fileId,
					messageId,
				);
				if (backfill instanceof Error) {
					log.warn("[pipeline] updateFileMessageId failed", {
						error: backfill.message,
					});
				}
			}
		}

		const trigger: Trigger = {
			kind: "message",
			messageId: effectiveMsg.id,
		};

		const partialTurn: Omit<TurnContext, "vars"> = {
			chatId: effectiveMsg.chatId,
			agent: def,
			runId: crypto.randomUUID(),
			trigger,
			overrides: parsed.overrides,
			config,
			message: effectiveMsg,
			messageRefs: {},
			pendingSubReplies: [],
		};

		if (msg.kind === "whatsapp") await startTyping(effectiveMsg.chatId);
		try {
			await executeAgent({
				turn: partialTurn,
				def,
				variables: getVariables(),
			});
		} finally {
			if (msg.kind === "whatsapp") await stopTyping(effectiveMsg.chatId);
		}
	} catch (err) {
		await reportPipelineError(msg, err);
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve setup mode: in self-mode the bot's own JID becomes the allowed
 * chat automatically; otherwise the user types a one-shot setup code.
 */
async function handleSetupMode(msg: InboundMessage): Promise<void> {
	if (settings.whatsapp.selfMode) {
		const ownJid = normalizeJid(getSocket().user?.id ?? "");
		if (!ownJid) {
			log.warn("[pipeline] self-mode: waiting for own JID");
			return;
		}
		log.info("[pipeline] self-mode: auto-setup");
		await updateAllowedChatId(ownJid);
		clearSetupCode();
		clearLoginFolder().catch(() => {});
		enqueueMessage({
			chatId: msg.chatId,
			content: "Hey! Klaus is set up and ready to go 🤙",
			dedupKey: `${msg.id}:setup-complete`,
			label: settings.whatsapp.systemLabel,
		});
		return;
	}

	const setupCode = getSetupCode();
	if (setupCode && msg.text?.trim() === setupCode) {
		log.info("[pipeline] setup code matched, configuring allowed chat");
		await updateAllowedChatId(msg.chatId);
		clearSetupCode();
		clearLoginFolder().catch(() => {});
		enqueueMessage({
			chatId: msg.chatId,
			content: "Hey! Klaus is set up and ready to go 🤙",
			dedupKey: `${msg.id}:setup-complete`,
			label: settings.whatsapp.systemLabel,
		});
	} else {
		log.info("[pipeline] setup mode, awaiting setup code");
		enqueueMessage({
			chatId: msg.chatId,
			content: `*Klaus setup*\n\nSend the setup code from the instructions in your vault to complete setup.\n\nYour chat ID: \`${msg.chatId}\``,
			dedupKey: `${msg.id}:setup`,
			label: settings.whatsapp.systemLabel,
		});
	}
}

/**
 * If this message is a reply to a stored message with media, attach the
 * quoted media so vision/document tools can see what the user is referring to.
 */
function resolveQuotedMedia(msg: InboundMessage): InboundMessage {
	if (!msg.quotedMessage) return msg;

	let quotedMedia: { fileId: string; path: string; mimeType: string } | null =
		null;
	const found = findByExternalId(msg.quotedMessage.externalId);
	if (found) quotedMedia = findFileByMessageId(found.messageId);
	if (!quotedMedia) {
		quotedMedia = findFileByExternalId(msg.quotedMessage.externalId);
	}
	if (!quotedMedia) return msg;

	return {
		...msg,
		quotedMessage: { ...msg.quotedMessage, media: quotedMedia },
	};
}

async function reportPipelineError(
	msg: InboundMessage,
	err: unknown,
): Promise<void> {
	log.error("[pipeline] unhandled error", {
		error: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	});

	if (msg.kind !== "whatsapp") return;

	try {
		enqueueMessage({
			chatId: msg.chatId,
			content: formatUserError(err),
			dedupKey: `${msg.id}:error`,
			label: settings.whatsapp.systemLabel,
		});
	} catch {
		/* best-effort */
	}

	try {
		const key = msg.messageKey as Parameters<typeof sendReaction>[1];
		await sendReaction(msg.chatId, key, "❌");
		const botId = getSocket().user?.id ?? "bot";
		await appendReaction({
			messageExternalId: msg.id,
			emoji: "❌",
			senderId: botId,
			fromMe: true,
		});
	} catch (reactErr) {
		log.warn("[pipeline] failed to apply error reaction", {
			error: reactErr instanceof Error ? reactErr.message : String(reactErr),
		});
	}
}
