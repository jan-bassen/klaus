import { settings } from "../config.ts";
import { log } from "../logger.ts";
import { getSocket } from "./connection.ts";

type PresenceKind = "composing" | "recording";

interface PresenceKeeper {
	kind: PresenceKind;
	interval: ReturnType<typeof setInterval>;
}

const keepers = new Map<string, PresenceKeeper>();

async function ping(chatId: string, kind: PresenceKind): Promise<void> {
	try {
		await getSocket().sendPresenceUpdate(kind, chatId);
	} catch {
		log.debug(`[presence] ${kind} ping failed`);
	}
}

/**
 * Start (or restart) a periodic presence ping for the given chat. Baileys'
 * `composing`/`recording` indicators expire after ~10s, so we re-send below
 * that threshold for the duration of the turn.
 */
export function startPresence(chatId: string, kind: PresenceKind): void {
	const existing = keepers.get(chatId);
	if (existing) clearInterval(existing.interval);

	ping(chatId, kind);
	const interval = setInterval(() => {
		const current = keepers.get(chatId);
		if (current) ping(chatId, current.kind);
	}, settings.whatsapp.presenceRefreshMs);
	keepers.set(chatId, { kind, interval });
}

/** Switch an active keeper's kind (e.g. composing → recording before a TTS reply). */
export function setPresenceKind(chatId: string, kind: PresenceKind): void {
	const existing = keepers.get(chatId);
	if (!existing || existing.kind === kind) return;
	existing.kind = kind;
	ping(chatId, kind);
}

/** Stop the keeper and clear the indicator. */
export async function stopPresence(chatId: string): Promise<void> {
	const existing = keepers.get(chatId);
	if (!existing) return;
	clearInterval(existing.interval);
	keepers.delete(chatId);
	try {
		await getSocket().sendPresenceUpdate("paused", chatId);
	} catch {
		log.debug("[presence] paused failed");
	}
}
