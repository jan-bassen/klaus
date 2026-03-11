import { log } from "@/logger";
import type { InboundMessage } from "@/types";
import { getSocket } from "./connection";

export type ConfirmResult = "confirmed" | "rejected" | "timeout";

const DEFAULT_TIMEOUT_MS = 60_000;

// Pending confirmations keyed by the ID of the prompt message Klaus sent.
// Each entry is a resolve function that accepts the final result.
const pending = new Map<string, (result: ConfirmResult) => void>();

/**
 * Send a confirmation prompt to the user and wait for a 👍 (confirmed) or
 * 👎 (rejected) reaction. Times out after timeoutMs (default 60 s).
 *
 * The prompt is sent directly via the socket (bypassing the FIFO queue) so
 * we can capture the sent message ID before registering the listener.
 *
 * Any reaction emoji other than 👍/👎 is ignored — the timeout still fires.
 */
export async function awaitConfirmation(
	msg: InboundMessage,
	prompt: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ConfirmResult> {
	const socket = getSocket();
	let sent: Awaited<ReturnType<typeof socket.sendMessage>>;
	try {
		sent = await socket.sendMessage(msg.chatId, { text: prompt });
	} catch (err) {
		log.error("[confirm] failed to send prompt", {
			chatId: msg.chatId,
			error: err instanceof Error ? err.message : String(err),
		});
		return "timeout";
	}

	const sentId = sent?.key?.id ?? undefined;
	if (!sentId) {
		log.warn("[confirm] no message ID returned — cannot track reaction", {
			chatId: msg.chatId,
		});
		return "timeout";
	}

	return new Promise<ConfirmResult>((resolve) => {
		const timer = setTimeout(() => {
			pending.delete(sentId);
			log.debug("[confirm] timed out", { sentId, chatId: msg.chatId });
			resolve("timeout");
		}, timeoutMs);

		pending.set(sentId, (result) => {
			clearTimeout(timer);
			pending.delete(sentId);
			log.debug("[confirm] resolved", { sentId, result, chatId: msg.chatId });
			resolve(result);
		});
	});
}

/**
 * Called by receive.ts for every incoming reaction event.
 * Resolves the pending confirmation if the reacted-to message ID is known.
 */
export function onReaction(reactedToMsgId: string, emoji: string): void {
	const resolve = pending.get(reactedToMsgId);
	if (!resolve) return;
	if (emoji === "👍") resolve("confirmed");
	else if (emoji === "👎") resolve("rejected");
	// Other emojis: do nothing — timeout will fire eventually
}

/** For testing: expose pending map size. */
export function _pendingSizeForTest(): number {
	return pending.size;
}
