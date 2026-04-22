import {
	agentRegistry,
	getDefaultAgent,
	getOrLoadAgent,
} from "@/agent/definitions";
import { runAgent } from "@/agent/runner";
import { buildTurn } from "@/agent/turn";
import { registry as commandRegistry, parseCommand } from "@/commands";
import { settings, updateAllowedChatId } from "@/config";
import { formatUserError } from "@/errors";
import { log } from "@/logger";
import {
	appendMessage,
	appendReaction,
	findByExternalId,
} from "@/store/conversation";
import {
	findFileByExternalId,
	findFileByMessageId,
	updateFileMessageId,
} from "@/store/files";
import { appendTrail } from "@/store/trail";
import { recordTurnLog, toLogSteps } from "@/store/turn-log";
import type { InboundMessage } from "@/types";
import { getSocket, normalizeJid } from "@/whatsapp/connection";
import {
	clearLoginFolder,
	clearSetupCode,
	getSetupCode,
} from "@/whatsapp/login";
import { startTyping, stopTyping } from "@/whatsapp/presence";
import { enqueueMessage, sendReaction } from "@/whatsapp/send";
import { rewriteVoiceTranscript, transcribe } from "@/whatsapp/voice";
import {
	extractUrls,
	fetchWebContent,
	isParseableDocument,
	parseDocument,
} from "./attachments";
import {
	parseOverrides,
	resolveAgentDefaults,
	resolveOverrides,
	stripOverrides,
} from "./overrides";
import { checkMessageRate } from "./rate-limit";

// ─── Inlined from middleware.ts ──────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single orchestrator for all user-initiated messages.
 *
 * Sequence:
 *   1. Auth        → checkAllowlist
 *   2. Rate check  → checkMessageRate
 *   3. Normalize   → transcribe voice / analyze image if applicable
 *   4. Parse       → resolve @agent and !overrides inline
 *   5. Route       → resolve target AgentDefinition
 *   6. Assemble    → context.assemble (all queries in parallel)
 *   7. Execute     → agent.runAgent
 */
export async function handleTurn(msg: InboundMessage): Promise<void> {
	try {
		// Step 1: Auth
		const auth = checkAllowlist(msg);
		if (!auth.allowed) {
			if (auth.setupMode) {
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
				return;
			}
			log.info("[auth] rejected unauthorized chat");
			return;
		}
		// Step 2: Rate check
		const rate = checkMessageRate(msg);
		if (!rate.allowed) {
			log.warn(`[pipeline] rate limited, retry in ${rate.retryAfterMs}ms`);
			enqueueMessage({
				chatId: msg.chatId,
				content: "Too many messages — please slow down.",
				dedupKey: `${msg.id}:rate-limit`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		// Step 3: Normalize — transcribe voice, parse documents; images pass through unchanged
		let processedMsg = msg;
		if (msg.media) {
			const { path: filePath, mimeType, fileId } = msg.media;
			if (mimeType.startsWith("audio/")) {
				log.info("[pipeline] transcribing voice message");
				const transcript = await transcribe(filePath, mimeType);
				if (!(transcript instanceof Error)) {
					processedMsg = {
						...msg,
						text: transcript,
						media: {
							...msg.media,
							fileId,
							path: filePath,
							mimeType,
							transcription: transcript,
							voiceCaption: msg.text ?? "",
						},
					};
				} else {
					log.warn("[pipeline] transcription failed", {
						error: transcript.message,
					});
				}
			} else if (isParseableDocument(mimeType)) {
				log.info("[pipeline] parsing document", { mimeType });
				const extracted = await parseDocument(filePath, mimeType);
				if (!(extracted instanceof Error)) {
					processedMsg = {
						...msg,
						media: { ...msg.media, extractedText: extracted },
					};
				}
			}
		}

		// Step 3b: Fetch web links embedded in message text
		const urlsInText = extractUrls(processedMsg.text ?? "");
		if (urlsInText.length > 0) {
			const urlsToFetch = urlsInText.slice(0, settings.web.maxUrls);
			log.info("[pipeline] fetching web links", { count: urlsToFetch.length });

			const results = await Promise.allSettled(
				urlsToFetch.map((u) => fetchWebContent(u)),
			);

			const links: NonNullable<InboundMessage["links"]> = [];
			for (const [i, r] of results.entries()) {
				const fetchedUrl = urlsToFetch[i] ?? "";
				if (r.status === "fulfilled" && !(r.value instanceof Error)) {
					links.push({ url: fetchedUrl, ...r.value });
				} else {
					const reason =
						r.status === "rejected" ? r.reason : (r.value as Error);
					log.warn("[pipeline] web fetch failed", {
						url: fetchedUrl,
						error: reason instanceof Error ? reason.message : String(reason),
					});
				}
			}

			if (links.length > 0) {
				processedMsg = { ...processedMsg, links };
			}
		}

		// Step 3c: Voice fuzzy matching — rewrite spoken agent/override patterns
		let rawText = processedMsg.text ?? "";
		if (processedMsg.media?.transcription) {
			rawText = rewriteVoiceTranscript(
				rawText,
				new Set(agentRegistry.keys()),
				settings.stt.agentTriggers,
			);
			processedMsg = { ...processedMsg, text: rawText };
		}

		// Step 4a: /commands bypass the LLM entirely
		const cmd = parseCommand(processedMsg);
		if (cmd) {
			log.info(`[pipeline] dispatching /${cmd.name} command`);

			// Persist command message to conversation
			await appendMessage({
				role: "user",
				content: processedMsg.text ?? null,
				externalId: processedMsg.id,
				command: cmd.name,
			});

			const command = commandRegistry.get(cmd.name);
			if (command) await command.execute(processedMsg, cmd.args);
			return;
		}

		// Step 4b + 5: Parse @agent route, strip routing prefix from text
		const routeMatch = rawText.match(/^@([\w-]+)\s*/);
		const agentName = routeMatch?.[1] ?? getDefaultAgent(processedMsg.chatId);
		const cleanText = routeMatch
			? rawText.slice(routeMatch[0].length)
			: rawText;

		// Parse overrides from cleanText BEFORE stripping
		const overrides = parseOverrides({
			...processedMsg,
			text: cleanText,
		});
		const presetConfig = resolveOverrides(overrides);
		const strippedText = stripOverrides(cleanText);

		// Strip overrides and routing prefix from msg text
		let effectiveMsg: InboundMessage = { ...processedMsg, text: strippedText };

		// Step 6: Resolve agent definition
		const def = await getOrLoadAgent(agentName);
		log.info(`[pipeline] routing to @${agentName}`);

		// Resolve agent defaults, per-message overrides take precedence
		const config = resolveAgentDefaults(presetConfig, def);

		// Resolve quoted message media if this is a reply
		if (effectiveMsg.quotedMessage) {
			let quotedMedia: {
				fileId: string;
				path: string;
				mimeType: string;
			} | null = null;
			const found = findByExternalId(effectiveMsg.quotedMessage.externalId);
			if (found) {
				quotedMedia = findFileByMessageId(found.messageId);
			}
			// Fallback: look up file directly by externalId (works for archived messages)
			if (!quotedMedia) {
				quotedMedia = findFileByExternalId(
					effectiveMsg.quotedMessage.externalId,
				);
			}
			if (quotedMedia) {
				effectiveMsg = {
					...effectiveMsg,
					quotedMessage: {
						...effectiveMsg.quotedMessage,
						media: quotedMedia,
					},
				};
			}
		}

		// Persist inbound message to conversation (skip for ghost mode)
		let messageId: string | undefined;
		if (!config.ghost) {
			const overrideNames = Object.keys(overrides);
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

		// Step 7: Build full TurnContext (resolves defaults + assembles variables)
		const turn = await buildTurn({
			chatId: effectiveMsg.chatId,
			def,
			message: effectiveMsg,
			overrides,
			presetConfig,
			...(messageId ? { messageId } : {}),
		});

		// Step 8: Execute agent
		if (msg.kind === "whatsapp") await startTyping(effectiveMsg.chatId);
		let agentResult: Awaited<ReturnType<typeof runAgent>> | undefined;
		try {
			agentResult = await runAgent(turn, def);
		} finally {
			if (msg.kind === "whatsapp") await stopTyping(effectiveMsg.chatId);
		}

		// Record turn log + vault trail (fire-and-forget)
		if (agentResult) {
			const overrideNames = Object.keys(overrides);
			const turnLogPayload = {
				...(messageId ? { messageId } : {}),
				chatId: effectiveMsg.chatId,
				agent: agentName,
				...(effectiveMsg.text ? { rawText: effectiveMsg.text } : {}),
				overrides: overrideNames,
				...(effectiveMsg.media
					? { mediaType: effectiveMsg.media.mimeType }
					: {}),
				provider: agentResult.provider,
				model: agentResult.model,
				tier: agentResult.tier,
				systemPrompt: agentResult.systemPrompt,
				userMessage: agentResult.userMessage,
				conversationMessages: agentResult.conversationMessages,
				steps: toLogSteps(agentResult.steps),
				promptTokens: agentResult.usage.promptTokens,
				completionTokens: agentResult.usage.completionTokens,
				durationMs: agentResult.durationMs,
				...(agentResult.replyContent
					? { replyContent: agentResult.replyContent }
					: {}),
			};
			recordTurnLog(turnLogPayload).catch((err) =>
				log.warn("[pipeline] failed to record turn log", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
			appendTrail(turnLogPayload).catch((err) =>
				log.warn("[pipeline] failed to append trail", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		}
	} catch (err) {
		log.error("[pipeline] unhandled error", {
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
		});
		if (msg.kind === "whatsapp") {
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
					error:
						reactErr instanceof Error ? reactErr.message : String(reactErr),
				});
			}
		}
	}
}
