import { z } from "zod";
import { log } from "@/logger";
import { appendAck, appendMessage } from "@/store/conversation";
import type { ToolDefinition } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";
import { textToSpeech } from "@/whatsapp/voice";

const replySchema = z.object({
	content: z.string().describe("The message content to send"),
	voice: z
		.boolean()
		.optional()
		.describe(
			"Send as a voice message using text-to-speech. Use when the user requested audio output (e.g. !voice).",
		),
	messageRef: z
		.string()
		.optional()
		.describe(
			'Message label from conversation history (e.g. "3") or "current" to quote-reply to that message. Omit for a normal reply.',
		),
});

export const replyTool: ToolDefinition<typeof replySchema> = {
	name: "reply",
	description:
		"Send a WhatsApp message — works both as a reply to an inbound message and as a proactive/scheduled send.",
	inputSchema: replySchema,
	execute: async ({ content, voice, messageRef }, context) => {
		// Inline dispatch: capture reply for caller instead of sending to WhatsApp
		if (context._replyCollector) {
			context._replyCollector.push(content);
			return "sent";
		}

		log.info("[reply] enqueuing", {
			chatId: context.chatId,
			preview: content.slice(0, 60),
		});

		// Resolve the quoted message reference if provided.
		let quoted: { externalId: string; fromMe: boolean } | undefined;
		if (messageRef) {
			let ref: { externalId: string; role: string } | undefined;
			if (messageRef === "current") {
				if (!context.message) {
					return {
						error: 'messageRef "current" requires an inbound message context',
					};
				}
				ref = { externalId: context.message.id, role: "user" };
			} else {
				ref = context.assembled?.messageRefs?.[messageRef];
			}
			if (!ref) return { error: `Unknown message reference: #${messageRef}` };
			quoted = { externalId: ref.externalId, fromMe: ref.role !== "user" };
		}

		// Persist assistant message to conversation (skip for ghost mode)
		let rowId: string | undefined;
		if (!context.overrides?.ghost) {
			try {
				rowId = await appendMessage({
					role: "assistant",
					content,
				});
			} catch (err) {
				log.warn("[reply] failed to persist assistant message", {
					chatId: context.chatId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		const onSent = rowId
			? (waId: string) => {
					appendAck(rowId, waId).catch((err: unknown) => {
						log.warn("[reply] failed to backfill externalId", {
							chatId: context.chatId,
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
			: undefined;

		const dedupBase = context.message
			? `${context.message.id}:reply:${crypto.randomUUID()}`
			: `${context.chatId}:reply:${crypto.randomUUID()}`;
		const quotedPart = quoted ? { quoted } : {};
		const useVoice =
			!context.overrides?.suppressVoice &&
			(voice || context.overrides?.forceVoice);
		if (useVoice) {
			const audio = await textToSpeech(content);
			if (audio instanceof Error) {
				log.warn("[reply] TTS failed — falling back to text", {
					chatId: context.chatId,
					error: audio.message,
				});
				enqueueMessage(
					{
						chatId: context.chatId,
						content,
						dedupKey: dedupBase,
						label: context.agent.name,
						...quotedPart,
					},
					onSent,
				);
			} else {
				enqueueMessage(
					{
						chatId: context.chatId,
						content: audio,
						mimeType: "audio/mpeg",
						dedupKey: context.message
							? `${context.message.id}:reply-voice:${crypto.randomUUID()}`
							: `${context.chatId}:reply-voice:${crypto.randomUUID()}`,
						label: context.agent.name,
						...quotedPart,
					},
					onSent,
				);
			}
		} else {
			enqueueMessage(
				{
					chatId: context.chatId,
					content,
					dedupKey: dedupBase,
					label: context.agent.name,
					...quotedPart,
				},
				onSent,
			);
		}

		return "sent";
	},
	kind: "builtin",
	capability: "tool",
};
