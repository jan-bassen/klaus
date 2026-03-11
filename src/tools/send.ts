import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { messages } from "@/db/schema";
import { log } from "@/logger";
import type { ToolDefinition } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";
import { textToSpeech } from "@/whatsapp/tts";

const sendSchema = z.object({
	content: z.string().describe("The message content to send"),
	voice: z
		.boolean()
		.optional()
		.describe("Send as a voice message using text-to-speech."),
});

export const sendTool: ToolDefinition<typeof sendSchema> = {
	name: "send",
	description:
		"Send a proactive WhatsApp message to the current chat. Use this instead of reply when there is no inbound message to respond to — e.g. from a scheduled or background agent. Same formatting rules as reply: *bold* _italic_ ```monospace``` > blockquote.",
	inputSchema: sendSchema,
	execute: async ({ content, voice }, context) => {
		log.info("[send] enqueuing", {
			chatId: context.chatId,
			preview: content.slice(0, 60),
		});

		let rowId: string | undefined;
		try {
			const [row] = await db
				.insert(messages)
				.values({
					chatId: context.chatId,
					role: "assistant",
					content,
					createdAt: new Date(),
				})
				.returning({ id: messages.id });
			rowId = row?.id;
		} catch (err) {
			log.warn("[send] failed to persist assistant message to DB", {
				chatId: context.chatId,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		const onSent = rowId
			? (waId: string) => {
					db.update(messages)
						.set({ externalId: waId })
						.where(eq(messages.id, rowId))
						.catch((err: unknown) => {
							log.warn("[send] failed to backfill externalId", {
								chatId: context.chatId,
								error: err instanceof Error ? err.message : String(err),
							});
						});
				}
			: undefined;

		const dedupKey = `${context.chatId}:send:${crypto.randomUUID()}`;

		if (voice) {
			const audio = await textToSpeech(content, context.chatId);
			if (audio instanceof Error) {
				log.warn("[send] TTS failed — falling back to text", {
					chatId: context.chatId,
					error: audio.message,
				});
				enqueueMessage({ chatId: context.chatId, content, dedupKey }, onSent);
			} else {
				enqueueMessage(
					{
						chatId: context.chatId,
						content: audio,
						mimeType: "audio/mpeg",
						dedupKey,
					},
					onSent,
				);
			}
		} else {
			enqueueMessage({ chatId: context.chatId, content, dedupKey }, onSent);
		}

		return "sent";
	},
	kind: "builtin",
	capability: "tool",
};
