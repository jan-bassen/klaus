import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import {
	downloadMediaMessage,
	normalizeMessageContent,
} from "@whiskeysockets/baileys";
import { formatUserError } from "@/errors";
import { settings } from "@/infra/config";
import { log } from "@/infra/logger";
import { findConfirmationByPromptId } from "@/infra/store/confirmations";
import { saveFileMeta } from "@/infra/store/files";
import { appendReaction } from "@/infra/store/history";
import { handleTurn } from "@/pipeline";
import { handleConfirmationResume } from "@/pipeline/confirmations";
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

const MIME_TO_EXT: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"audio/ogg": "ogg",
	"audio/mpeg": "mp3",
	"audio/mp4": "m4a",
	"audio/wav": "wav",
	"video/mp4": "mp4",
	"application/pdf": "pdf",
};

function mimeToExt(mime: string): string {
	return MIME_TO_EXT[mime] ?? mime.split("/")[1] ?? "bin";
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
				if (!fromMe) {
					maybeResolveConfirmation(reactedId, reaction.text, chatId).catch(
						(err) =>
							log.warn("[receive] confirmation resolve failed", {
								error: err instanceof Error ? err.message : String(err),
							}),
					);
				}
			}
		}
	});
}

/**
 * Look up a pending confirmation by the WhatsApp message externalId the
 * user reacted to; if the emoji is in the configured approve/deny set,
 * fire `handleConfirmationResume`. Anything else (including the user's
 * own ad-hoc reactions to bot messages) is ignored.
 */
async function maybeResolveConfirmation(
	reactedId: string,
	emoji: string,
	chatId: string,
): Promise<void> {
	const entry = findConfirmationByPromptId(reactedId);
	if (!entry) return;
	if (entry.chatId !== chatId) return;

	const decision = classifyEmoji(emoji);
	if (!decision) return;

	log.info(
		`[receive] reaction ${emoji} → ${decision} for ${entry.id} (${entry.triggerSummary})`,
	);
	await handleConfirmationResume(entry.id, { decision });
}

function classifyEmoji(emoji: string): "approve" | "deny" | null {
	const trimmed = emoji.trim();
	if (settings.agent.confirmEmojis.approve.includes(trimmed)) return "approve";
	if (settings.agent.confirmEmojis.deny.includes(trimmed)) return "deny";
	return null;
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
	const m = raw as {
		key?: {
			remoteJid?: string;
			fromMe?: boolean;
			id?: string;
			participant?: string;
		};
		message?: {
			conversation?: string;
			extendedTextMessage?: {
				text?: string;
				contextInfo?: {
					stanzaId?: string;
					quotedMessage?: {
						conversation?: string;
						extendedTextMessage?: { text?: string };
					};
				};
			};
			imageMessage?: {
				mimetype?: string;
				caption?: string;
				fileLength?: number | bigint;
			};
			audioMessage?: {
				mimetype?: string;
				ptt?: boolean;
				fileLength?: number | bigint;
			};
			documentMessage?: {
				mimetype?: string;
				fileName?: string;
				caption?: string;
				fileLength?: number | bigint;
			};
		};
		messageTimestamp?: number | bigint;
	};

	// Skip messages without a remote JID
	if (!m?.key?.remoteJid) return null;
	// Skip messages we sent — in self-mode, only skip our own replies (not user self-messages)
	if (m.key.fromMe) {
		if (!settings.whatsapp.selfMode) {
			log.debug("[receive] ignoring outbound message");
			return null;
		}
		if (m.key.id && wasSentByUs(m.key.id)) {
			log.debug("[receive] ignoring own reply in self-mode");
			return null;
		}
		log.debug("[receive] processing self-message");
	}
	if (!m.message) {
		log.debug("[receive] ignoring empty message");
		return null;
	}

	const normalized = normalizeMessageContent(raw.message) ?? m.message;

	const text =
		normalized.conversation ||
		normalized.extendedTextMessage?.text ||
		undefined;

	// Extract quoted message context when this message is a reply
	const contextInfo = normalized.extendedTextMessage?.contextInfo;
	let quotedMessage: InboundMessage["quotedMessage"] | undefined;
	if (contextInfo?.quotedMessage && contextInfo.stanzaId) {
		const qm = contextInfo.quotedMessage;
		const quotedText =
			qm.conversation || qm.extendedTextMessage?.text || undefined;
		quotedMessage = {
			externalId: contextInfo.stanzaId,
			...(quotedText ? { text: quotedText } : {}),
		};
	}

	const imgMsg = normalized.imageMessage;
	const audioMsg = normalized.audioMessage;
	const docMsg = normalized.documentMessage;
	const mediaMsg = imgMsg ?? audioMsg ?? docMsg ?? null;

	if (!text && !mediaMsg && !quotedMessage) {
		log.debug("[receive] ignoring message with no text or media");
		return null;
	}

	const rawTs = m.messageTimestamp;
	const tsSeconds =
		typeof rawTs === "bigint" ? Number(rawTs) : (rawTs ?? Date.now() / 1000);

	const effectiveText = text ?? imgMsg?.caption ?? docMsg?.caption ?? undefined;

	let media: InboundMessage["media"] | undefined;

	if (mediaMsg) {
		const rawMime =
			imgMsg?.mimetype ??
			audioMsg?.mimetype ??
			docMsg?.mimetype ??
			"application/octet-stream";
		const mimeType = rawMime.split(";")[0]?.trim() ?? rawMime;

		const fileLength = Number(
			imgMsg?.fileLength ?? audioMsg?.fileLength ?? docMsg?.fileLength ?? 0,
		);
		if (fileLength > MAX_DOWNLOAD_BYTES) {
			log.warn(
				`[receive] media too large (${fileLength} bytes), skipping download`,
			);
		} else
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

				const date = new Date().toISOString().slice(0, 10);
				const id = crypto.randomUUID();
				const ext = mimeToExt(mimeType);
				const dir = path.join(settings.dataDir, "files", date);
				const filePath = path.join(dir, `${id}.${ext}`);

				await mkdir(dir, { recursive: true });
				if (!Buffer.isBuffer(buffer)) {
					log.warn(
						"[receive] media download returned unexpected type, skipping",
					);
				} else {
					await Bun.write(filePath, buffer);

					const sizeBytes = buffer.byteLength;
					const saved = await saveFileMeta({
						path: filePath,
						mimeType,
						sizeBytes,
						...(m.key.id ? { externalId: m.key.id } : {}),
					});

					const fileName = docMsg?.fileName;
					if (saved instanceof Error) {
						log.warn("[receive] failed to save file metadata", {
							error: saved.message,
						});
						media = {
							fileId: crypto.randomUUID(),
							path: filePath,
							mimeType,
							...(fileName ? { fileName } : {}),
						};
					} else {
						media = {
							fileId: saved.id,
							path: filePath,
							mimeType,
							...(fileName ? { fileName } : {}),
						};
					}
				}
			} catch (err) {
				log.warn("[receive] media download failed, continuing as text-only", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
	}

	// If media download failed for a voice note, inject a fallback so the pipeline
	// can still acknowledge the message instead of silently dropping it.
	const fallbackText =
		!media && audioMsg?.ptt
			? "(voice note — could not be downloaded)"
			: undefined;

	if (!effectiveText && !fallbackText && !media && !quotedMessage) {
		log.debug("[receive] ignoring message with no usable content");
		return null;
	}

	return {
		kind: "whatsapp",
		id: m.key.id ?? crypto.randomUUID(),
		chatId: m.key.remoteJid,
		senderId: m.key.participant ?? m.key.remoteJid,
		...(effectiveText
			? { text: effectiveText }
			: fallbackText
				? { text: fallbackText }
				: {}),
		...(media ? { media } : {}),
		...(quotedMessage ? { quotedMessage } : {}),
		timestamp: new Date(tsSeconds * 1000),
		messageKey: m.key as Record<string, unknown>,
	};
}
