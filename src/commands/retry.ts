import type { Command } from "@/commands";
import { settings } from "@/config";
import { formatUserError } from "@/errors";
import { log } from "@/logger";
import { executeRetry, loadHistory } from "@/pipeline/retry";
import {
	appendReaction,
	appendSupersede,
	findByExternalId,
} from "@/store/conversation";
import type { InboundMessage } from "@/types";
import { getSocket } from "@/whatsapp/connection";
import { enqueueMessage, type MessageKey, sendReaction } from "@/whatsapp/send";

const ERROR_EMOJI = "❌";

/**
 * Resolve the user message to retry.
 *
 * - No quote: the most recent persisted user message that is not itself a command.
 * - Quote on a user message: that message.
 * - Quote on an assistant message: walk back to the user message that triggered it.
 */
function resolveTarget(
	history: Awaited<ReturnType<typeof loadHistory>>,
	quotedExternalId: string | undefined,
	currentExternalId: string,
) {
	if (quotedExternalId) {
		const found = findByExternalId(quotedExternalId);
		if (!found) return null;
		const idx = history.findIndex((m) => m.id === found.messageId);
		if (idx === -1) return null;
		const row = history[idx];
		if (!row) return null;
		if (row.role === "user") return row;
		// Assistant row — walk back to the preceding user message
		for (let i = idx - 1; i >= 0; i--) {
			const prior = history[i];
			if (prior?.role === "user" && !prior.command) return prior;
		}
		return null;
	}

	// No quote — last non-command user msg that isn't the current /retry itself
	for (let i = history.length - 1; i >= 0; i--) {
		const row = history[i];
		if (!row) continue;
		if (row.externalId === currentExternalId) continue;
		if (row.role === "user" && !row.command) return row;
	}
	return null;
}

export const retryCommand: Command = {
	name: "retry",
	aliases: ["r"],
	description:
		"Re-run the last turn (or a quoted turn). Useful when an agent reply failed or was unsatisfactory.",
	async execute(msg: InboundMessage): Promise<void> {
		const history = await loadHistory();
		const quotedExternalId = msg.quotedMessage?.externalId;
		const target = resolveTarget(history, quotedExternalId, msg.id);

		if (!target || !target.externalId) {
			enqueueMessage({
				chatId: msg.chatId,
				content: "Nothing to retry.",
				dedupKey: `${msg.id}:retry-empty`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		// Supersede the /retry command message itself so it doesn't appear in history.
		const self = findByExternalId(msg.id);
		if (self) await appendSupersede(self.messageId, "retry-self");

		// Supersede any assistant messages that followed the target, up to the /retry.
		const targetIdx = history.findIndex((m) => m.id === target.id);
		if (targetIdx >= 0) {
			for (let i = targetIdx + 1; i < history.length; i++) {
				const row = history[i];
				if (!row) continue;
				if (row.externalId === msg.id) break;
				if (row.role === "assistant") {
					await appendSupersede(row.id, "retry");
				} else {
					// Stop at the next user message — don't supersede later unrelated turns.
					break;
				}
			}
		}

		const botId = getSocket().user?.id ?? "bot";
		const targetKey: MessageKey = {
			remoteJid: msg.chatId,
			fromMe: false,
			id: target.externalId,
		};

		try {
			await executeRetry(msg.chatId, target);
			// Clear any prior ❌ reaction on the target user message.
			await sendReaction(msg.chatId, targetKey, "");
			await appendReaction({
				messageExternalId: target.externalId,
				emoji: "",
				senderId: botId,
				fromMe: true,
			});
		} catch (err) {
			log.error("[retry] executeRetry failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			await sendReaction(msg.chatId, targetKey, ERROR_EMOJI);
			await appendReaction({
				messageExternalId: target.externalId,
				emoji: ERROR_EMOJI,
				senderId: botId,
				fromMe: true,
			});
			enqueueMessage({
				chatId: msg.chatId,
				content: formatUserError(err),
				dedupKey: `${msg.id}:retry-error`,
				label: settings.whatsapp.systemLabel,
			});
		}
	},
};
