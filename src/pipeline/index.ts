/**
 * Inbound message orchestrator — single entry point for WhatsApp turns.
 *
 *   1. Auth (allowlist)
 *   2. Normalize + parse (STT, doc, links, commands, /next, @agent, !overrides)
 *   3. Resolve agent + build effective config
 *   4. Resolve quoted media + persist message
 *   5. Execute agent (assemble context, prompts, run loop)
 */

import { formatUserError } from "../errors.ts";
import { settings, updateAllowedChat } from "../infra/config.ts";
import { activateFutureWorkIfReady } from "../infra/future.ts";
import { log } from "../infra/logger.ts";
import {
	findFileByExternalId,
	findFileByMessageId,
	updateFileMessageId,
} from "../infra/store/files.ts";
import {
	appendMessage,
	appendReaction,
	findByExternalId,
	getConversation,
} from "../infra/store/history.ts";
import { getSocket, normalizeJid } from "../infra/whatsapp/connection.ts";
import {
	completeConfiguredLogin,
	getSetupCode,
} from "../infra/whatsapp/login.ts";
import { startPresence, stopPresence } from "../infra/whatsapp/presence.ts";
import type { InboundMessage } from "../infra/whatsapp/receive.ts";
import { enqueueMessage, sendReaction } from "../infra/whatsapp/send.ts";
import { registry as commandRegistry } from "../primitives/commands/index.ts";
import { getVariables } from "../primitives/variables/index.ts";
import { getDefaultAgent, getOrLoadAgent } from "./agents.ts";
import type { Trigger, TurnContext } from "./core.ts";
import { executeAgent, isAbortError } from "./core.ts";
import { parseMessage } from "./message.ts";
import { consumeNextPrefix, getNextPrefix } from "./next.ts";
import { buildTurnConfig } from "./overrides.ts";
import { registerActiveRun } from "./runs.ts";
import { renderTemplate } from "./templates.ts";

interface AuthResult {
	allowed: boolean;
	setupMode?: boolean;
}

interface ActiveTurn {
	ac: AbortController;
	done: Promise<void>;
}

const activeTurns = new Map<string, ActiveTurn>();
const turnGenerations = new Map<string, number>();
let nextTurnGeneration = 1;

/** Verify the sender's chatId matches the configured allowed chat. Fail-closed: unset blocks all. */
function checkAllowlist(msg: InboundMessage): AuthResult {
	const allowed = settings.allowedChat ?? "";
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
	const arrivalGeneration = nextTurnGeneration++;
	let failedContext: { agent: string; runId: string } | undefined;
	try {
		const auth = checkAllowlist(msg);
		if (!auth.allowed) {
			if (auth.setupMode) await handleSetupMode(msg);
			return;
		}

		const nextPrefix = getNextPrefix(msg.chatId);
		const parsed = await parseMessage(msg, nextPrefix);
		const processedMsg = parsed.msg;
		const effectiveMsg = resolveQuotedMedia(processedMsg);

		if (parsed.command) {
			log.info(`[pipeline] dispatching /${parsed.command.name} command`);
			const command = commandRegistry.get(parsed.command.name);
			if (command) await command.execute(effectiveMsg, parsed.command.args);
			return;
		}

		if (nextPrefix !== undefined) consumeNextPrefix(processedMsg.chatId);

		const agentName = parsed.agent ?? getDefaultAgent(processedMsg.chatId);
		const def = await getOrLoadAgent(agentName);
		log.info(`[pipeline] routing to @${agentName}`);
		const config = buildTurnConfig(def, parsed.overrides);

		let messageId: string | undefined;
		if (!config.ghost) {
			const overrideNames = Object.keys(parsed.overrides);
			const quotedContext = await buildQuotedContext(effectiveMsg);
			messageId = await appendMessage({
				role: "user",
				content: effectiveMsg.text ?? null,
				externalId: effectiveMsg.id,
				...(quotedContext ?? {}),
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

		const turnKey = `${effectiveMsg.chatId}:${agentName}`;
		const latestGeneration = turnGenerations.get(turnKey) ?? 0;
		if (arrivalGeneration < latestGeneration) {
			throw new DOMException("Turn superseded", "AbortError");
		}
		const generation = arrivalGeneration;
		turnGenerations.set(turnKey, generation);
		for (;;) {
			const existing = activeTurns.get(turnKey);
			if (!existing) break;
			existing.ac.abort();
			await existing.done;
			if (turnGenerations.get(turnKey) !== generation) {
				throw new DOMException("Turn superseded", "AbortError");
			}
		}

		const ac = new AbortController();
		const unregisterActiveRun = registerActiveRun(ac);
		let resolveThis!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveThis = resolve;
		});
		const activeEntry: ActiveTurn = { ac, done };
		activeTurns.set(turnKey, activeEntry);

		const trigger: Trigger = {
			kind: "message",
			messageId: effectiveMsg.id,
		};

		const runId = crypto.randomUUID();
		failedContext = { agent: def.name, runId };

		const partialTurn: Omit<TurnContext, "vars"> = {
			chatId: effectiveMsg.chatId,
			agent: def,
			runId,
			trigger,
			overrides: parsed.overrides,
			config,
			message: effectiveMsg,
			messageRefs: {},
		};

		try {
			if (msg.kind === "whatsapp") {
				startPresence(
					effectiveMsg.chatId,
					config.forceVoice ? "recording" : "composing",
				);
			}
			await executeAgent({
				turn: partialTurn,
				def,
				variables: getVariables(),
				signal: ac.signal,
			});
		} finally {
			unregisterActiveRun();
			if (msg.kind === "whatsapp") await stopPresence(effectiveMsg.chatId);
			if (activeTurns.get(turnKey) === activeEntry) {
				activeTurns.delete(turnKey);
			}
			if (turnGenerations.get(turnKey) === generation) {
				turnGenerations.delete(turnKey);
			}
			resolveThis();
		}
	} catch (err) {
		if (!isAbortError(err)) {
			await reportPipelineError(msg, err, failedContext);
		}
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
		await updateAllowedChat(ownJid);
		activateFutureWorkIfReady();
		enqueueMessage({
			chatId: msg.chatId,
			content: renderTemplate("welcome", {}),
			dedupKey: `${msg.id}:setup-complete`,
			label: settings.whatsapp.systemLabel,
		});
		await completeConfiguredLogin();
		return;
	}

	const setupCode = getSetupCode();
	if (setupCode && msg.text?.trim() === setupCode) {
		log.info("[pipeline] setup code matched, configuring allowed chat");
		await updateAllowedChat(msg.chatId);
		activateFutureWorkIfReady();
		enqueueMessage({
			chatId: msg.chatId,
			content: renderTemplate("welcome", {}),
			dedupKey: `${msg.id}:setup-complete`,
			label: settings.whatsapp.systemLabel,
		});
		await completeConfiguredLogin();
	} else {
		log.info("[pipeline] setup mode, awaiting setup code");
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

async function buildQuotedContext(
	msg: InboundMessage,
): Promise<{ quotedText: string; quotedRole: string } | undefined> {
	const quoted = msg.quotedMessage;
	if (!quoted) return undefined;

	const rows = await getConversation();
	const prior = rows.find((row) => row.externalId === quoted.externalId);
	const role = prior?.role ?? "user";
	const text = firstText(
		quoted.text,
		prior?.content,
		describeQuotedMedia(quoted),
	);

	return text ? { quotedText: text, quotedRole: role } : undefined;
}

function firstText(
	...values: Array<string | null | undefined>
): string | undefined {
	for (const value of values) {
		const text = value?.trim();
		if (text) return text;
	}
	return undefined;
}

function describeQuotedMedia(
	quoted: NonNullable<InboundMessage["quotedMessage"]>,
): string | undefined {
	const media = quoted.media ?? findFileByExternalId(quoted.externalId);
	if (!media) return "quoted message";
	if (media.mimeType.startsWith("image/")) return "quoted image";
	if (media.mimeType.startsWith("audio/")) return "quoted voice note";
	return `quoted attachment (${media.mimeType})`;
}

async function reportPipelineError(
	msg: InboundMessage,
	err: unknown,
	context?: { agent: string; runId: string },
): Promise<void> {
	log.error("[pipeline] unhandled error", {
		error: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	});

	if (msg.kind !== "whatsapp") return;

	const errorContent = formatUserError(err);

	try {
		enqueueMessage({
			chatId: msg.chatId,
			content: errorContent,
			dedupKey: `${msg.id}:error`,
			label: settings.whatsapp.systemLabel,
		});
	} catch {
		/* best-effort */
	}

	if (context) {
		try {
			await appendMessage({
				role: "assistant",
				content: errorContent,
				agent: context.agent,
				runId: context.runId,
				failed: true,
			});
		} catch (persistErr) {
			log.warn("[pipeline] failed to persist failed assistant message", {
				error:
					persistErr instanceof Error ? persistErr.message : String(persistErr),
			});
		}
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
