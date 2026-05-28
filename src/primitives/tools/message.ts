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
import { prepareAssistantOutbound } from "../../pipeline/outbound.ts";
import { renderTemplate } from "../../pipeline/templates.ts";
import type { ToolDefinition } from "./index.ts";

/** The canonical name of the output tool. Referenced by runner/messages to filter message sends from traces. */
export const SEND_MESSAGE_TOOL_NAME = "send_message";

const sendMessageSchema = z.object({
	text: z
		.string({ error: "Send the complete message text in text." })
		.min(1, { error: "Send the complete message text in text." })
		.refine((value) => value.trim().length > 0, "Message content is required")
		.describe("Complete text of the WhatsApp message to send."),
	asVoiceNote: z
		.boolean({ error: "asVoiceNote must be a boolean value." })
		.optional()
		.describe(
			"Set true to send this same text as a WhatsApp voice note. Omit for a normal text message.",
		),
	quoteMessageLabel: z
		.number({
			error:
				"quoteMessageLabel must be an integer message label, not a string.",
		})
		.int({
			error:
				"quoteMessageLabel must be an integer message label, not a string.",
		})
		.nonnegative({
			error: "quoteMessageLabel must be 0 or a positive visible message label.",
		})
		.optional()
		.describe(
			"Visible message label to quote in WhatsApp. Use the positive integer from a history ref like 'ref #3'. Omit for normal messages; 0 is accepted but ignored.",
		),
});

export const sendMessageTool: ToolDefinition<typeof sendMessageSchema> = {
	name: SEND_MESSAGE_TOOL_NAME,
	description:
		"Send one user-visible WhatsApp message when the final text is ready. Use asVoiceNote only for voice-note delivery of that same text.",
	inputSchema: sendMessageSchema,
	execute: async ({ text, asVoiceNote, quoteMessageLabel }, context) => {
		// Inline agent runs return the message text to their caller instead of sending to WhatsApp.
		if (context._replyCollector) {
			context._replyCollector.push(text);
			return "sent";
		}

		log.info("[send_message] enqueuing message");

		const userFacingContent = formatUserFacingAgentMessage(text, context);
		const useVoice = shouldSendVoice(asVoiceNote, context);
		try {
			if (useVoice) {
				setPresenceKind(context.chatId, "recording");
				const audio = await textToSpeech(text);
				if (audio instanceof Error) {
					const outbound = await prepareSendMessageOutbound(
						context,
						text,
						quoteMessageLabel,
					);
					if ("error" in outbound) return outbound;
					log.warn("[send_message] TTS failed, falling back to text", {
						error: audio.message,
					});
					enqueueMessage(
						{
							chatId: context.chatId,
							content: userFacingContent,
							dedupKey: outbound.dedupKey,
							label: context.agent.name,
							...quotedPart(outbound),
						},
						outbound.onSent,
					);
				} else {
					const voiceOutbound = await prepareSendMessageOutbound(
						context,
						text,
						quoteMessageLabel,
						true,
					);
					if ("error" in voiceOutbound) return voiceOutbound;
					enqueueMessage(
						{
							chatId: context.chatId,
							content: audio.bytes,
							mimeType: audio.mimeType,
							...(audio.mimeType.includes("opus") ? { voiceNote: true } : {}),
							dedupKey: voiceOutbound.dedupKey,
							label: context.agent.name,
							...quotedPart(voiceOutbound),
						},
						voiceOutbound.onSent,
					);
				}
			} else {
				const outbound = await prepareSendMessageOutbound(
					context,
					text,
					quoteMessageLabel,
				);
				if ("error" in outbound) return outbound;
				enqueueMessage(
					{
						chatId: context.chatId,
						content: userFacingContent,
						dedupKey: outbound.dedupKey,
						label: context.agent.name,
						...quotedPart(outbound),
					},
					outbound.onSent,
				);
			}

			return "sent";
		} finally {
			await stopPresence(context.chatId);
		}
	},
};

type PreparedSendMessageOutbound = Exclude<
	Awaited<ReturnType<typeof prepareAssistantOutbound>>,
	{ error: string }
>;

function prepareSendMessageOutbound(
	context: TurnContext,
	text: string,
	quoteMessageLabel: number | undefined,
	voice = false,
): ReturnType<typeof prepareAssistantOutbound> {
	return prepareAssistantOutbound({
		context,
		content: text,
		kind: voice ? "send-message-voice" : "send-message",
		logPrefix: "[send_message]",
		...(voice ? { voice } : {}),
		...(quoteMessageLabel !== undefined
			? { messageRef: quoteMessageLabel }
			: {}),
	});
}

function quotedPart(
	outbound: PreparedSendMessageOutbound,
): Partial<Pick<PreparedSendMessageOutbound, "quoted">> {
	return outbound.quoted ? { quoted: outbound.quoted } : {};
}

function shouldSendVoice(
	asVoiceNote: boolean | undefined,
	context: TurnContext,
): boolean {
	if (context.config?.suppressVoice) return false;
	if (context.config?.forceVoice) return true;
	return asVoiceNote === true;
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
