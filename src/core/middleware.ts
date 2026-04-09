import { log } from "@/logger";
import { settings } from "@/settings";
import type { InboundMessage } from "@/types";

export interface AuthResult {
	allowed: boolean;
	setupMode?: boolean;
}

// --- Allowlist ---

/** Verify the sender's chatId matches the configured allowedChatId. Fail-closed: unset blocks all. */
export function checkAllowlist(msg: InboundMessage): AuthResult {
	const allowed = settings.allowedChatId ?? "";
	if (allowed === "") {
		log.warn("[middleware] allowedChatId not configured — setup mode", {
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
