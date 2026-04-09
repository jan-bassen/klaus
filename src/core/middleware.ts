import { log } from "@/logger";
import type { InboundMessage } from "@/types";

export interface AuthResult {
	allowed: boolean;
	setupMode?: boolean;
}

// --- Allowlist ---

/** Verify the sender's chatId matches the single configured chat. Fail-closed: unset env blocks all. */
export function checkAllowlist(msg: InboundMessage): AuthResult {
	const allowed = process.env.ALLOWED_CHAT_ID ?? "";
	if (allowed === "") {
		log.warn("[middleware] ALLOWED_CHAT_ID not set — setup mode", {
			chatId: msg.chatId,
		});
		return { allowed: false, setupMode: true };
	}
	if (msg.chatId !== allowed) {
		log.warn("[middleware] auth rejected", { chatId: msg.chatId });
		return { allowed: false };
	}
	return { allowed: true };
}
