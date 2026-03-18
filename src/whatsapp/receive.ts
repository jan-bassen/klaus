import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import {
	downloadMediaMessage,
	normalizeMessageContent,
} from "@whiskeysockets/baileys";
import { formatUserError } from "@/core/errors";
import { handleTurn } from "@/core/pipeline";
import { log } from "@/logger";
import { settings } from "@/settings";
import { appendReaction } from "@/store/conversation";
import { saveFileMeta } from "@/store/files";
import type { InboundMessage } from "@/types";
import { onReaction } from "./confirm";
import { enqueueMessage, setSocket } from "./send";

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024; // 64 MB
const STARTUP_AT = Date.now();
const OFFLINE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

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
				log.info("[receive] message", {
					chatId: msg.chatId,
					text: msg.text?.slice(0, 40),
					kind: msg.kind,
				});
				try {
					await handleTurn(msg);
				} catch (err) {
					log.error("[receive] unhandled error from handleTurn", {
						chatId: msg.chatId,
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
					try {
						enqueueMessage({
							chatId: msg.chatId,
							content: formatUserError(err),
							dedupKey: `${msg.id}:receive-error`,
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
					log.warn("[receive] appendReaction failed", {
						messageExternalId: reactedId,
						error: err instanceof Error ? err.message : String(err),
					});
				});
				onReaction(reactedId, reaction.text);
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

	// Skip messages we sent and messages without a remote JID
	if (!m?.key?.remoteJid) return null;
	if (m.key.fromMe) {
		log.debug("[receive] skip fromMe", { remoteJid: m.key.remoteJid });
		return null;
	}
	if (!m.message) {
		log.debug("[receive] skip no-message", { remoteJid: m.key.remoteJid });
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
		log.debug("[receive] skip no-text no-media", {
			remoteJid: m.key.remoteJid,
		});
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
			log.warn("[receive] media too large — skipping download", {
				remoteJid: m.key.remoteJid,
				fileLength,
				maxBytes: MAX_DOWNLOAD_BYTES,
			});
		} else
			try {
				const buffer = await downloadMediaMessage(raw, "buffer", {});

				const date = new Date().toISOString().slice(0, 10);
				const id = crypto.randomUUID();
				const ext = mimeToExt(mimeType);
				const dir = path.join(settings.files.dir, date);
				const filePath = path.join(dir, `${id}.${ext}`);

				await mkdir(dir, { recursive: true });
				if (!Buffer.isBuffer(buffer)) {
					log.warn(
						"[receive] downloadMediaMessage returned non-Buffer — skipping",
						{
							remoteJid: m.key.remoteJid,
						},
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
						log.warn("[receive] saveFileMeta failed — media not tracked", {
							remoteJid: m.key.remoteJid,
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
				log.warn("[receive] media download failed — continuing as text-only", {
					remoteJid: m.key.remoteJid,
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
		log.debug("[receive] skip no content", { remoteJid: m.key.remoteJid });
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
