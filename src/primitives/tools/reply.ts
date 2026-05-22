import { z } from "zod";
import { log } from "../../infra/logger.ts";
import { setPresenceKind } from "../../infra/whatsapp/presence.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import { getDefaultAgent } from "../../pipeline/agents.ts";
import type { TurnContext } from "../../pipeline/core.ts";
import { textToSpeech } from "../../pipeline/media.ts";
import {
	makeDedupKey,
	prepareAssistantOutbound,
} from "../../pipeline/outbound.ts";
import { renderTemplate } from "../../pipeline/prompts.ts";
import type { ToolDefinition } from "./index.ts";

/** The canonical name of the output tool. Referenced by runner/messages to filter reply calls from traces. */
export const REPLY_TOOL_NAME = "reply";

const replySchema = z.object({
	content: z
		.string()
		.min(1)
		.refine((value) => value.trim().length > 0, "Message content is required")
		.describe("The non-empty message content to send"),
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
	name: REPLY_TOOL_NAME,
	description:
		"Send a WhatsApp message — works both as a reply to an inbound message and as a proactive/scheduled send.",
	inputSchema: replySchema,
	execute: async ({ content, voice, messageRef }, context) => {
		// Inline dispatch: capture reply for caller instead of sending to WhatsApp
		if (context._replyCollector) {
			context._replyCollector.push(content);
			return "sent";
		}

		log.info("[reply] enqueuing message");

		const userFacingContent = formatUserFacingAgentMessage(content, context);
		const useVoice =
			!context.config?.suppressVoice && (voice || context.config?.forceVoice);
		if (useVoice) {
			setPresenceKind(context.chatId, "recording");
			const audio = await textToSpeech(content);
			if (audio instanceof Error) {
				const outbound = await prepareAssistantOutbound({
					context,
					content,
					kind: "reply",
					logPrefix: "[reply]",
					...(messageRef ? { messageRef } : {}),
				});
				if ("error" in outbound) return outbound;
				const quotedPart = outbound.quoted ? { quoted: outbound.quoted } : {};
				log.warn("[reply] TTS failed, falling back to text", {
					error: audio.message,
				});
				enqueueMessage(
					{
						chatId: context.chatId,
						content: userFacingContent,
						dedupKey: outbound.dedupKey,
						label: context.agent.name,
						...quotedPart,
					},
					outbound.onSent,
				);
			} else {
				const voiceOutbound = await prepareAssistantOutbound({
					context,
					content,
					kind: "reply",
					logPrefix: "[reply]",
					voice: true,
					...(messageRef ? { messageRef } : {}),
				});
				if ("error" in voiceOutbound) return voiceOutbound;
				const voiceQuotedPart = voiceOutbound.quoted
					? { quoted: voiceOutbound.quoted }
					: {};
				enqueueMessage(
					{
						chatId: context.chatId,
						content: audio,
						mimeType: "audio/mpeg",
						dedupKey: makeDedupKey(context, "reply-voice"),
						label: context.agent.name,
						...voiceQuotedPart,
					},
					voiceOutbound.onSent,
				);
			}
		} else {
			const outbound = await prepareAssistantOutbound({
				context,
				content,
				kind: "reply",
				logPrefix: "[reply]",
				...(messageRef ? { messageRef } : {}),
			});
			if ("error" in outbound) return outbound;
			const quotedPart = outbound.quoted ? { quoted: outbound.quoted } : {};
			enqueueMessage(
				{
					chatId: context.chatId,
					content: userFacingContent,
					dedupKey: outbound.dedupKey,
					label: context.agent.name,
					...quotedPart,
				},
				outbound.onSent,
			);
		}

		return "sent";
	},
};

function formatUserFacingAgentMessage(
	content: string,
	context: TurnContext,
): string {
	const defaultAgentName = getDefaultAgent(context.chatId);
	const isDefaultAgent = context.agent.name === defaultAgentName;
	return renderTemplate("message-agent", {
		message: content,
		agentName: context.agent.name,
		agentLabel: context.agent.name,
		defaultAgentName,
		isDefaultAgent,
		isNotDefaultAgent: !isDefaultAgent,
	});
}
