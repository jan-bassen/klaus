import path from "node:path";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import type { AgentDefinition, InboundMessage, TurnContext } from "@/types";
import {
	type AgentRunResult,
	agentRegistry,
	loadAgentDefinition,
	runAgent,
} from "./agent";
import { checkAllowlist } from "./middleware";
import { checkMessageRate } from "./rate-limiter";

// ─── Test seam ────────────────────────────────────────────────────────────────
let _agentRunner: (
	turn: TurnContext,
	def: AgentDefinition,
) => Promise<AgentRunResult> = runAgent;
export function _setAgentRunnerForTest(
	fn: (turn: TurnContext, def: AgentDefinition) => Promise<AgentRunResult>,
): void {
	_agentRunner = fn;
}
export function _clearAgentRunnerForTest(): void {
	_agentRunner = runAgent;
}

import { registry as commandRegistry, parseCommand } from "@/commands";
import { getDefaultAgent } from "@/core/defaults";
import {
	buildTemplateVars,
	overrideRegistry,
	parseoverrides,
	resolveoverrides,
	stripoverrides,
} from "@/core/overrides";
import { log } from "@/logger";
import { settings } from "@/settings";
import { appendMessage, findByExternalId } from "@/store/conversation";
import {
	findFileByExternalId,
	findFileByMessageId,
	updateFileMessageId,
} from "@/store/files";
import { appendTrail } from "@/store/trail";
import { recordTurnLog, toLogSteps } from "@/store/turn-log";
import { getSocket } from "@/whatsapp/connection";
import {
	clearLoginFolder,
	clearSetupCode,
	getSetupCode,
} from "@/whatsapp/login";
import { startTyping, stopTyping } from "@/whatsapp/presence";
import { enqueueMessage } from "@/whatsapp/send";
import { transcribe } from "@/whatsapp/voice";
import { assembleContext } from "./assemble";
import { formatUserError } from "./errors";
import {
	extractVarParams,
	mergeVarParams,
	readPromptBody,
} from "./interpolate";
import { resolveAgentDefaults } from "./overrides";
import { updateAllowedChatId } from "./settings-loader";
import { rewriteVoiceTranscript } from "./voice-parse";

function agentsDir(): string {
	return settings.vault.agentsDir;
}

/**
 * The single orchestrator for all user-initiated messages.
 *
 * Sequence:
 *   1. Auth        → middleware.checkAllowlist
 *   2. Rate check  → rateLimiter.checkMessageRate
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
					const ownJid = jidNormalizedUser(getSocket().user?.id ?? "");
					if (!ownJid) {
						log.warn("[pipeline] self-mode: cannot resolve own JID yet");
						return;
					}
					log.info("[pipeline] self-mode: auto-setup", {
						chatId: ownJid,
					});
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
					log.info("[pipeline] setup code matched, configuring allowedChatId", {
						chatId: msg.chatId,
					});
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
					log.info("[pipeline] setup mode — awaiting setup code", {
						chatId: msg.chatId,
					});
					enqueueMessage({
						chatId: msg.chatId,
						content: `*Klaus setup*\n\nSend the setup code from the instructions in your vault to complete setup.\n\nYour chat ID: \`${msg.chatId}\``,
						dedupKey: `${msg.id}:setup`,
						label: settings.whatsapp.systemLabel,
					});
				}
				return;
			}
			log.info("[pipeline] auth rejected", { chatId: msg.chatId });
			return;
		}
		// Step 2: Rate check
		const rate = checkMessageRate(msg);
		if (!rate.allowed) {
			log.warn("[pipeline] rate limited", {
				chatId: msg.chatId,
				retryAfterMs: rate.retryAfterMs,
			});
			enqueueMessage({
				chatId: msg.chatId,
				content: "Too many messages — please slow down.",
				dedupKey: `${msg.id}:rate-limit`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		// Step 3: Normalize — transcribe voice; images and documents pass through unchanged
		let processedMsg = msg;
		if (msg.media) {
			const { path: filePath, mimeType, fileId } = msg.media;
			if (mimeType.startsWith("audio/")) {
				log.info("[pipeline] transcribing voice message", {
					chatId: msg.chatId,
					mimeType,
				});
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
						chatId: msg.chatId,
						error: transcript.message,
					});
				}
			}
		}

		// Step 3b: Voice fuzzy matching — rewrite spoken agent/override patterns
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
			log.info("[pipeline] command dispatched", {
				chatId: processedMsg.chatId,
				command: cmd.name,
			});

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
		const activeoverrides = parseoverrides({
			...processedMsg,
			text: cleanText,
		});
		const presetoverrides = resolveoverrides(activeoverrides);
		const strippedText = stripoverrides(cleanText);

		// Strip overrides and routing prefix from msg text
		let effectiveMsg: InboundMessage = { ...processedMsg, text: strippedText };

		// Step 6: Resolve agent definition
		let def = agentRegistry.get(agentName);
		if (!def) {
			const promptPath = path.join(agentsDir(), `${agentName}.md`);
			def = await loadAgentDefinition(promptPath);
			agentRegistry.set(def.name, def);
		}
		log.info("[pipeline] routing to agent", {
			chatId: effectiveMsg.chatId,
			agent: agentName,
		});

		// Resolve agent defaults, per-message overrides take precedence
		const overrides = resolveAgentDefaults(presetoverrides, def);

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
		if (!overrides.ghost) {
			const overrideNames = Object.keys(activeoverrides);
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

		// Build partial TurnContext for context assembly
		const partialTurn: Omit<TurnContext, "assembled"> = {
			chatId: effectiveMsg.chatId,
			message: effectiveMsg,
			agent: def,
			activeoverrides,
			overrides,
			templateVars: buildTemplateVars(overrides, def),
			...(messageId ? { messageId } : {}),
		};

		// Extract var params from agent prompt and user message
		const promptBody = await readPromptBody(def.promptPath);
		const varParams = mergeVarParams(
			extractVarParams(promptBody, "hbs"),
			extractVarParams(effectiveMsg.text ?? "", "dollar"),
		);

		// Step 7: Assemble context (all queries in parallel)
		const assembled = await assembleContext(
			partialTurn,
			undefined,
			Object.keys(varParams).length > 0 ? varParams : undefined,
		);
		const turn: TurnContext = { ...partialTurn, assembled };

		// Step 8: Execute agent
		if (msg.kind === "whatsapp") await startTyping(effectiveMsg.chatId);
		let agentResult: Awaited<ReturnType<typeof _agentRunner>> | undefined;
		try {
			agentResult = await _agentRunner(turn, def);
		} finally {
			if (msg.kind === "whatsapp") await stopTyping(effectiveMsg.chatId);
		}

		// Record turn log + vault trail (fire-and-forget)
		if (agentResult) {
			const overrideNames = Object.keys(activeoverrides);
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
				contextTokens: assembled.totalTokens,
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
			chatId: msg.chatId,
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
		}
	}
}
