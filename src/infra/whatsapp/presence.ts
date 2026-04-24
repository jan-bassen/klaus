import { log } from "@/infra/logger";
import { getSocket } from "./connection";

/**
 * Send a "composing" (typing...) presence update for the given chat.
 * Best-effort — errors are silently swallowed.
 */
export async function startTyping(chatId: string): Promise<void> {
	try {
		await getSocket().sendPresenceUpdate("composing", chatId);
	} catch {
		log.debug("[presence] startTyping failed");
	}
}

/**
 * Send a "paused" presence update to clear the typing indicator.
 * Best-effort — errors are silently swallowed.
 */
export async function stopTyping(chatId: string): Promise<void> {
	try {
		await getSocket().sendPresenceUpdate("paused", chatId);
	} catch {
		log.debug("[presence] stopTyping failed");
	}
}
