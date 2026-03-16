import path from "node:path";
import type { AgentDefinition, InboundMessage, TurnContext } from "@/types";
import { agentRegistry, loadAgentDefinition, runAgent } from "./agent";
import { checkAllowlist } from "./middleware";
import { checkMessageRate } from "./rate-limiter";

// ─── Test seam ────────────────────────────────────────────────────────────────
let _agentRunner: (turn: TurnContext, def: AgentDefinition) => Promise<void> =
	runAgent;
export function _setAgentRunnerForTest(
	fn: (turn: TurnContext, def: AgentDefinition) => Promise<void>,
): void {
	_agentRunner = fn;
}
export function _clearAgentRunnerForTest(): void {
	_agentRunner = runAgent;
}

import { registry as commandRegistry, parseCommand } from "@/commands";
import { config } from "@/config";
import { getDefaultAgent } from "@/core/defaults";
import { log } from "@/logger";
import { appendMessage, findByExternalId } from "@/store/conversation";
import { findFileByMessageId, updateFileMessageId } from "@/store/files";
import { parseFlags, stripFlags } from "@/whatsapp/flags";
import { startTyping, stopTyping } from "@/whatsapp/presence";
import { enqueueMessage } from "@/whatsapp/send";
import { transcribe } from "@/whatsapp/voice";
import { assembleContext } from "./assemble";

function agentsDir(): string {
	return path.join(config.vault.dir, "Klaus", "agents");
}

/**
 * The single orchestrator for all user-initiated messages.
 *
 * Sequence:
 *   1. Auth        → middleware.checkAllowlist
 *   2. Rate check  → rateLimiter.checkMessageRate
 *   3. Normalize   → transcribe voice / analyze image if applicable
 *   4. Parse       → resolve @agent and !flags inline
 *   5. Route       → resolve target AgentDefinition
 *   6. Assemble    → context.assemble (all queries in parallel)
 *   7. Execute     → agent.runAgent
 */
export async function handleTurn(msg: InboundMessage): Promise<void> {
	try {
		// Step 1: Auth
		if (!checkAllowlist(msg).allowed) {
			log.info("[pipeline] auth rejected", { chatId: msg.chatId });
			return;
		}
		log.info("[pipeline] auth ok", { chatId: msg.chatId });

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
			});
			return;
		}

		// Step 3: Normalize — transcribe voice; images and documents pass through unchanged
		let processedMsg = msg;
		if (msg.media) {
			const { path: filePath, mimeType, fileId } = msg.media;
			if (mimeType.startsWith("audio/")) {
				const transcript = await transcribe(filePath, mimeType, msg.chatId);
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

		const rawText = processedMsg.text ?? "";

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

		// Parse flags from cleanText BEFORE stripping
		const flags = parseFlags({ ...processedMsg, text: cleanText });
		const strippedText = stripFlags(cleanText);

		// Strip flags and routing prefix from msg text
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

		// Resolve quoted message media if this is a reply
		if (effectiveMsg.quotedMessage) {
			const found = findByExternalId(effectiveMsg.quotedMessage.externalId);
			if (found) {
				const quotedMedia = findFileByMessageId(found.messageId);
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
		}

		// Persist inbound message to conversation
		const flagNames = Object.keys(flags);
		const messageId = await appendMessage({
			role: "user",
			content: effectiveMsg.text ?? null,
			externalId: effectiveMsg.id,
			...(effectiveMsg.quotedMessage?.text
				? { quotedText: effectiveMsg.quotedMessage.text, quotedRole: "user" }
				: {}),
			...(flagNames.length > 0 ? { flags: flagNames } : {}),
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

		// Build partial TurnContext for context assembly
		const partialTurn: Omit<TurnContext, "assembled"> = {
			chatId: effectiveMsg.chatId,
			message: effectiveMsg,
			agent: def,
			flags,
			messageId,
		};

		// Step 7: Assemble context (all queries in parallel)
		const assembled = await assembleContext(partialTurn);
		log.info("[pipeline] context assembled", {
			chatId: effectiveMsg.chatId,
			totalTokens: assembled.totalTokens,
		});

		const turn: TurnContext = { ...partialTurn, assembled };

		// Step 8: Execute agent
		log.info("[pipeline] agent execution started", {
			chatId: effectiveMsg.chatId,
			agent: agentName,
		});
		if (msg.kind === "whatsapp") await startTyping(effectiveMsg.chatId);
		try {
			await _agentRunner(turn, def);
		} finally {
			if (msg.kind === "whatsapp") await stopTyping(effectiveMsg.chatId);
		}
		log.info("[pipeline] agent execution completed", {
			chatId: effectiveMsg.chatId,
			agent: agentName,
		});
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		log.error("[pipeline] unhandled error", {
			chatId: msg.chatId,
			error: errMsg,
			stack: err instanceof Error ? err.stack : undefined,
		});
		if (msg.kind === "whatsapp") {
			const isRateLimit = /rate.?limit/i.test(errMsg);
			const userMsg = isRateLimit
				? "Too many requests right now — please try again in a moment."
				: "Something went wrong processing your message. Please try again.";
			try {
				enqueueMessage({
					chatId: msg.chatId,
					content: userMsg,
					dedupKey: `${msg.id}:error`,
				});
			} catch {
				// best-effort; ignore
			}
		}
	}
}
