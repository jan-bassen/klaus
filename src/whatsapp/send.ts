import type {
	AnyMessageContent,
	WAMessageKey,
	WASocket,
} from "@whiskeysockets/baileys";
import { settings } from "@/config";
import { log } from "@/logger";

// -- Send queue types (owned by this domain) --

export type MessageOrdinal = number;

export interface OutboundMessage {
	chatId: string;
	content: string | Buffer;
	mimeType?: string;
	/** Dedup key: (message_id, ordinal) for deduplicating outbound messages */
	dedupKey: string;
	/** When set, the message is sent as a WhatsApp quote-reply to this message. */
	quoted?: { externalId: string; fromMe: boolean };
	/** Self-mode prefix: "[label]: ..." — set by callers (agent name, "System", etc.) */
	label?: string;
}

import { getSocket } from "./connection";

// Module-level socket reference set by attachReceiveHandler at startup.
let _socket: WASocket | null = null;

/** Called by receive.ts when the Baileys socket is established. */
export function setSocket(socket: WASocket): void {
	_socket = socket;
}

/**
 * Returns a promise that resolves when the current send queue has fully drained.
 * Use during graceful shutdown to avoid dropping in-flight messages.
 */
export function drainQueue(): Promise<void> {
	return _queue;
}

// Single FIFO promise chain for message ordering.
let _queue: Promise<void> = Promise.resolve();
// In-memory dedup: skip re-sending a key within the current process lifetime.
// Capped at MAX_SEEN_SIZE to prevent unbounded memory growth in long-running processes.
const _seen = new Set<string>();
const _sentIds = new Set<string>();
const MAX_SEEN_SIZE = settings.whatsapp.maxSeenSize;

/** Check if a Baileys message ID was sent by us (for self-mode loop prevention). */
export function wasSentByUs(msgId: string): boolean {
	return _sentIds.has(msgId);
}

function trackSentId(id: string | null | undefined): void {
	if (!id) return;
	if (_sentIds.size >= MAX_SEEN_SIZE) {
		const oldest = _sentIds.values().next().value;
		if (oldest !== undefined) _sentIds.delete(oldest);
	}
	_sentIds.add(id);
}

/**
 * Enqueue an outbound message for delivery: ensures FIFO ordering, deduplication
 * by composite key, WhatsApp rate-limit backoff, and retry.
 * The optional onSent callback receives the Baileys message ID after successful delivery.
 */
export function enqueueMessage(
	msg: OutboundMessage,
	onSent?: (waId: string) => void,
): void {
	if (_seen.has(msg.dedupKey)) return;
	if (_seen.size >= MAX_SEEN_SIZE) {
		const oldest = _seen.values().next().value;
		if (oldest !== undefined) _seen.delete(oldest);
	}
	_seen.add(msg.dedupKey);

	_queue = _queue
		.then(() => sendWithRetry(msg))
		.then((waId) => {
			if (onSent && waId) onSent(waId);
		})
		.catch((err: unknown) => {
			log.error("[send] delivery failed after all retries", {
				error: err instanceof Error ? err.message : String(err),
			});
			// Best-effort delivery-failure notification so the user knows the message was lost.
			// One attempt only, no retry, to avoid an infinite failure loop.
			if (_socket) {
				_socket
					.sendMessage(msg.chatId, {
						text: "Failed to deliver my last message. Please try again.",
					})
					.then((result) => trackSentId(result?.key?.id))
					.catch((sendErr: unknown) => {
						log.warn("[send] could not notify user of delivery failure", {
							error:
								sendErr instanceof Error ? sendErr.message : String(sendErr),
						});
					});
			}
		});
}

function mediaContent(content: Buffer, mimeType?: string): AnyMessageContent {
	const mime = mimeType ?? "application/octet-stream";
	if (mime.startsWith("image/")) return { image: content, mimetype: mime };
	if (mime.startsWith("audio/")) return { audio: content, mimetype: mime };
	if (mime.startsWith("video/")) return { video: content, mimetype: mime };
	return { document: content, mimetype: mime };
}

async function sendWithRetry(
	msg: OutboundMessage,
	attempt = 1,
): Promise<string | null> {
	if (!_socket)
		throw new Error("No WhatsApp socket — call setSocket() before sending");

	let effectiveContent = msg.content;
	if (settings.whatsapp.selfMode && typeof effectiveContent === "string") {
		const prefix = msg.label ? `[${msg.label}]` : "[Klaus]";
		effectiveContent = `${prefix}: ${effectiveContent}`;
	}

	const waContent =
		typeof effectiveContent === "string"
			? { text: effectiveContent }
			: mediaContent(effectiveContent, msg.mimeType);

	try {
		if (attempt > 1) {
			log.info(`[send] retrying delivery (attempt ${attempt})`);
		}
		const sendOpts = msg.quoted
			? {
					quoted: {
						key: {
							remoteJid: msg.chatId,
							fromMe: msg.quoted.fromMe,
							id: msg.quoted.externalId,
						},
					},
				}
			: undefined;
		const result = await _socket.sendMessage(msg.chatId, waContent, sendOpts);
		trackSentId(result?.key?.id);
		log.info("[send] message delivered");
		await new Promise<void>((r) =>
			setTimeout(r, settings.send.interMessageDelayMs),
		);
		return result?.key?.id ?? null;
	} catch (err) {
		if (attempt < settings.retries.max) {
			await new Promise<void>((r) =>
				setTimeout(r, settings.retries.backoffMs * attempt),
			);
			return sendWithRetry(msg, attempt + 1);
		}
		throw err;
	}
}

// -- Reactions --

/**
 * Send a reaction emoji to a specific message.
 * Pass an empty string as emoji to remove an existing reaction.
 * Errors are returned as values — reactions are best-effort UX.
 */
export async function sendReaction(
	chatId: string,
	msgKey: WAMessageKey,
	emoji: string,
): Promise<undefined | Error> {
	try {
		await getSocket().sendMessage(chatId, {
			react: { key: msgKey, text: emoji },
		});
		log.debug("[send] reaction sent");
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		log.warn("[send] reaction failed", {
			error: error.message,
		});
		return error;
	}
}
