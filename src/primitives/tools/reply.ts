import { z } from "zod";
import { log } from "../../infra/logger.ts";
import {
	setPresenceKind,
	stopPresence,
} from "../../infra/whatsapp/presence.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import { getDefaultAgent } from "../../pipeline/agents.ts";
import type { TurnContext } from "../../pipeline/core.ts";
import { textToSpeech } from "../../pipeline/media.ts";
import {
	makeDedupKey,
	prepareAssistantOutbound,
} from "../../pipeline/outbound.ts";
import { renderTemplate } from "../../pipeline/templates.ts";
import type { ToolDefinition } from "./index.ts";

/** The canonical name of the output tool. Referenced by runner/messages to filter reply calls from traces. */
export const REPLY_TOOL_NAME = "reply";

const replySchema = z.object({
	content: z
		.string()
		.min(1)
		.refine((value) => value.trim().length > 0, "Message content is required")
		.describe("The complete content of the final message to send (required)."),
	voice: z
		.boolean()
		.optional()
		.describe(
			"Delivery choice for this completed message. Set true only when the content should be spoken as a voice note.",
		),
	messageRef: z
		.string()
		.optional()
		.describe(
			'Message label from conversation history (e.g. "3") to quote-reply to an older message. Omit for a normal reply.',
		),
});

export const replyTool: ToolDefinition<typeof replySchema> = {
	name: REPLY_TOOL_NAME,
	description:
		"Send one user-visible WhatsApp message only when the final content is ready; use voice as the delivery flag for that same content.",
	inputSchema: replySchema,
	execute: async ({ content, voice, messageRef }, context) => {
		// Inline dispatch: capture reply for caller instead of sending to WhatsApp
		if (context._replyCollector) {
			context._replyCollector.push(content);
			return "sent";
		}

		log.info("[reply] enqueuing message");

		const userFacingContent = formatUserFacingAgentMessage(content, context);
		const useVoice = shouldSendVoice(voice, context);
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
						content: audio.bytes,
						mimeType: audio.mimeType,
						...(audio.mimeType.includes("opus") ? { voiceNote: true } : {}),
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

		await stopPresence(context.chatId);
		return "sent";
	},
};

function shouldSendVoice(
	voice: boolean | undefined,
	context: TurnContext,
): boolean {
	if (context.config?.suppressVoice) return false;
	if (context.config?.forceVoice) return true;
	return voice === true;
}

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
