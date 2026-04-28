import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import {
	downloadMediaMessage,
	normalizeMessageContent,
} from "@whiskeysockets/baileys";
import { formatUserError } from "@/errors";
import { settings } from "@/infra/config";
import { log } from "@/infra/logger";
import { persistFileBlob } from "@/infra/store/files";
import { appendReaction } from "@/infra/store/history";
import { handleTurn } from "@/pipeline";
import { enqueueMessage, setSocket, wasSentByUs } from "./send";

/**
 * Enriched inbound WhatsApp message. Built in this module from a raw
 * Baileys `WAMessage`, then flows through the whole pipeline as the
 * canonical user-input shape. Populated incrementally:
 *   - `media` is filled as the blob downloads into the files store.
 *   - `media.transcription` / `media.extractedText` are added by
 *     `pipeline/media.ts` during normalize.
 *   - `quotedMessage.media` is resolved in `pipeline/index.ts` from the
 *     files store when the user replies to a prior attachment.
 */
export interface InboundMessage {
	kind: "whatsapp";
	id: string;
	chatId: string;
	senderId: string;
	text?: string;
	media?: {
		fileId: string;
		path: string;
		mimeType: string;
		transcription?: string;
		/** For voice notes: the original typed caption before transcript replaced text. */
		voiceCaption?: string;
		/** For documents: the original filename from Baileys. */
		fileName?: string;
		/** For documents: text extracted by the parser (populated in normalize). */
		extractedText?: string;
	};
	/** Set by this module when the message is a reply to another message. */
	quotedMessage?: {
		externalId: string;
		text?: string;
		media?: { fileId: string; path: string; mimeType: string };
	};
	timestamp: Date;
	messageKey: Record<string, unknown>;
}

const MAX_DOWNLOAD_BYTES = settings.whatsapp.maxDownload;
const STARTUP_AT = Date.now();
const OFFLINE_WINDOW_MS = settings.whatsapp.offlineWindow;

type RawInboundMessage = {
	key?: {
		remoteJid?: string | null;
		fromMe?: boolean | null;
		id?: string | null;
		participant?: string | null;
	};
	message?: WhatsAppMessageContent;
	messageTimestamp?: number | bigint;
};

type WhatsAppMessageContent = {
	conversation?: string | null;
	extendedTextMessage?: {
		text?: string | null;
		contextInfo?: {
			stanzaId?: string | null;
			quotedMessage?: {
				conversation?: string | null;
				extendedTextMessage?: { text?: string | null };
			};
		};
	};
	imageMessage?: {
		mimetype?: string | null;
		caption?: string | null;
		fileLength?: number | bigint | null;
	};
	audioMessage?: {
		mimetype?: string | null;
		ptt?: boolean | null;
		fileLength?: number | bigint | null;
	};
	documentMessage?: {
		mimetype?: string | null;
		fileName?: string | null;
		caption?: string | null;
		fileLength?: number | bigint | null;
	};
};

interface AcceptedMessage {
	key: {
		remoteJid: string;
		fromMe?: boolean | null;
		id?: string | null;
		participant?: string | null;
	};
	message: WhatsAppMessageContent;
	messageTimestamp?: number | bigint;
}

interface MessageParts {
	text?: string;
	effectiveText?: string;
	media?: MediaDescriptor;
}

interface MediaDescriptor {
	mimeType: string;
	fileLength: number;
	fileName?: string;
	isVoiceNote: boolean;
}

/**
 * Attach the message event handler to the Baileys socket.
 * For each incoming message: normalizes it to InboundMessage (including media
 * auto-persist) then hands it to pipeline.handleTurn.
 * Pure transport — no business logic.
 */
export function attachReceiveHandler(socket: WASocket): void {
	setSocket(socket);

	socket.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
		if (type !== "notify" && type !== "append") return;
		for (const raw of msgs) {
			if (type === "append") {
				const rawTs = (raw as { messageTimestamp?: number | bigint })
					.messageTimestamp;
				const tsMs =
					(typeof rawTs === "bigint" ? Number(rawTs) : (rawTs ?? 0)) * 1000;
				if (tsMs < STARTUP_AT - OFFLINE_WINDOW_MS) continue;
			}
			const msg = await normalizeMessage(raw);
			if (msg) {
				log.info("[receive] incoming message");
				socket.readMessages([raw.key]).catch(() => {});
				try {
					await handleTurn(msg);
				} catch (err) {
					log.error("[receive] unhandled error in handleTurn", {
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
					try {
						enqueueMessage({
							chatId: msg.chatId,
							content: formatUserError(err),
							dedupKey: `${msg.id}:receive-error`,
							label: settings.whatsapp.systemLabel,
						});
					} catch {
						/* best-effort */
					}
				}
			}
		}
	});

	socket.ev.on("messages.reaction", (reactions) => {
		for (const { key: senderKey, reaction } of reactions) {
			const reactedId = reaction.key?.id;
			const chatId = reaction.key?.remoteJid ?? senderKey?.remoteJid;
			const senderId = senderKey?.participant ?? senderKey?.remoteJid ?? "";
			const fromMe = senderKey?.fromMe ?? false;
			// Skip echoes of our own reactions (empty sender, garbled metadata)
			if (!senderId) continue;
			if (
				typeof reactedId === "string" &&
				typeof reaction.text === "string" &&
				chatId
			) {
				appendReaction({
					messageExternalId: reactedId,
					emoji: reaction.text,
					senderId,
					fromMe,
				}).catch((err) => {
					log.warn("[receive] failed to append reaction", {
						error: err instanceof Error ? err.message : String(err),
					});
				});

				// Confirmation routing: if the reacted-to message is an open
				// confirmation prompt and the emoji classifies, fire the resume.
				// Bot's own reactions are skipped — only user reactions count.
			}
		}
	});
}

/**
 * Normalize a raw Baileys message into an InboundMessage.
 * Downloads and persists media blobs (voice, images, documents) before returning.
 *
 * Returns null for outbound, non-media/text, or unsupported message types.
 */
export async function normalizeMessage(
	raw: WAMessage,
): Promise<InboundMessage | null> {
	const m = raw as RawInboundMessage;
	if (!shouldAcceptMessage(m)) return null;
	if (!m.message || !m.key?.remoteJid) return null;
	const accepted: AcceptedMessage = {
		key: { ...m.key, remoteJid: m.key.remoteJid },
		message: m.message,
		...(m.messageTimestamp !== undefined
			? { messageTimestamp: m.messageTimestamp }
			: {}),
	};

	const normalized = (normalizeMessageContent(raw.message) ??
		accepted.message) as WhatsAppMessageContent;
	const quotedMessage = extractQuotedMessage(normalized);
	const parts = extractMessageParts(normalized);

	if (!parts.text && !parts.media && !quotedMessage) {
		log.debug("[receive] ignoring message with no text or media");
		return null;
	}

	const media = parts.media
		? await downloadAndPersistMedia(
				raw,
				parts.media,
				accepted.key.id ?? undefined,
			)
		: undefined;
	const fallbackText = buildFallbackText(parts.media, media);

	if (!parts.effectiveText && !fallbackText && !media && !quotedMessage) {
		log.debug("[receive] ignoring message with no usable content");
		return null;
	}

	return buildInboundMessage(
		accepted,
		parts,
		media,
		fallbackText,
		quotedMessage,
	);
}

function shouldAcceptMessage(m: RawInboundMessage): boolean {
	if (!m?.key?.remoteJid) return false;
	if (m.key.fromMe) {
		if (!settings.whatsapp.selfMode) {
			log.debug("[receive] ignoring outbound message");
			return false;
		}
		if (m.key.id && wasSentByUs(m.key.id)) {
			log.debug("[receive] ignoring own reply in self-mode");
			return false;
		}
		log.debug("[receive] processing self-message");
	}
	if (!m.message) {
		log.debug("[receive] ignoring empty message");
		return false;
	}
	return true;
}

function extractQuotedMessage(
	message: WhatsAppMessageContent,
): InboundMessage["quotedMessage"] | undefined {
	const contextInfo = message.extendedTextMessage?.contextInfo;
	if (!contextInfo?.quotedMessage || !contextInfo.stanzaId) return undefined;

	const quoted = contextInfo.quotedMessage;
	const quotedText =
		quoted.conversation || quoted.extendedTextMessage?.text || undefined;
	return {
		externalId: contextInfo.stanzaId,
		...(quotedText ? { text: quotedText } : {}),
	};
}

function extractMessageParts(message: WhatsAppMessageContent): MessageParts {
	const text = message.conversation || message.extendedTextMessage?.text;
	const effectiveText =
		text || message.imageMessage?.caption || message.documentMessage?.caption;
	const media = extractMediaDescriptor(message);

	return {
		...(text ? { text } : {}),
		...(effectiveText ? { effectiveText } : {}),
		...(media ? { media } : {}),
	};
}

function extractMediaDescriptor(
	message: WhatsAppMessageContent,
): MediaDescriptor | undefined {
	if (message.imageMessage) {
		return {
			mimeType: cleanMimeType(message.imageMessage.mimetype),
			fileLength: fileLength(message.imageMessage.fileLength),
			isVoiceNote: false,
		};
	}

	if (message.audioMessage) {
		return {
			mimeType: cleanMimeType(message.audioMessage.mimetype),
			fileLength: fileLength(message.audioMessage.fileLength),
			isVoiceNote: message.audioMessage.ptt === true,
		};
	}

	if (message.documentMessage) {
		return {
			mimeType: cleanMimeType(message.documentMessage.mimetype),
			fileLength: fileLength(message.documentMessage.fileLength),
			...(message.documentMessage.fileName
				? { fileName: message.documentMessage.fileName }
				: {}),
			isVoiceNote: false,
		};
	}

	return undefined;
}

function cleanMimeType(rawMime: string | null | undefined): string {
	const mime = rawMime ?? "application/octet-stream";
	return mime.split(";")[0]?.trim() ?? mime;
}

function fileLength(value: number | bigint | null | undefined): number {
	return Number(value ?? 0);
}

async function downloadAndPersistMedia(
	raw: WAMessage,
	media: MediaDescriptor,
	externalId: string | undefined,
): Promise<InboundMessage["media"] | undefined> {
	if (media.fileLength > MAX_DOWNLOAD_BYTES) {
		log.warn(
			`[receive] media too large (${media.fileLength} bytes), skipping download`,
		);
		return undefined;
	}

	try {
		const buffer = await Promise.race([
			downloadMediaMessage(raw, "buffer", {}),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("media download timed out")),
					settings.whatsapp.mediaDownloadTimeout,
				),
			),
		]);

		if (!Buffer.isBuffer(buffer)) {
			log.warn("[receive] media download returned unexpected type, skipping");
			return undefined;
		}

		const saved = await persistFileBlob({
			bytes: buffer,
			mimeType: media.mimeType,
			...(externalId ? { externalId } : {}),
		});

		if (saved instanceof Error) {
			log.warn("[receive] failed to save file metadata", {
				error: saved.message,
			});
			return undefined;
		}

		if (!saved.metadataSaved) {
			log.warn("[receive] failed to save file metadata", {
				path: saved.path,
			});
		}
		return {
			fileId: saved.id,
			path: saved.path,
			mimeType: media.mimeType,
			...(media.fileName ? { fileName: media.fileName } : {}),
		};
	} catch (err) {
		log.warn("[receive] media download failed, continuing as text-only", {
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}

function buildFallbackText(
	descriptor: MediaDescriptor | undefined,
	media: InboundMessage["media"] | undefined,
): string | undefined {
	return !media && descriptor?.isVoiceNote
		? "(voice note — could not be downloaded)"
		: undefined;
}

function buildInboundMessage(
	m: AcceptedMessage,
	parts: MessageParts,
	media: InboundMessage["media"] | undefined,
	fallbackText: string | undefined,
	quotedMessage: InboundMessage["quotedMessage"] | undefined,
): InboundMessage {
	const rawTs = m.messageTimestamp;
	const tsSeconds =
		typeof rawTs === "bigint" ? Number(rawTs) : (rawTs ?? Date.now() / 1000);

	return {
		kind: "whatsapp",
		id: m.key.id ?? crypto.randomUUID(),
		chatId: m.key.remoteJid,
		senderId: m.key.participant ?? m.key.remoteJid,
		...(parts.effectiveText
			? { text: parts.effectiveText }
			: fallbackText
				? { text: fallbackText }
				: {}),
		...(media ? { media } : {}),
		...(quotedMessage ? { quotedMessage } : {}),
		timestamp: new Date(tsSeconds * 1000),
		messageKey: m.key as Record<string, unknown>,
	};
}
