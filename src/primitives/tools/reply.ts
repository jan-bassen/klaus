import { z } from "zod";
import { log } from "@/infra/logger";
import { enqueueMessage } from "@/infra/whatsapp/send";
import { getDefaultAgent } from "@/pipeline/agents";
import type { TurnContext } from "@/pipeline/core";
import { textToSpeech } from "@/pipeline/media";
import { makeDedupKey, prepareAssistantOutbound } from "@/pipeline/outbound";
import { renderTemplate } from "@/pipeline/prompts";
import type { ToolDefinition } from "@/primitives/tools";

/** The canonical name of the output tool. Referenced by runner/messages to filter reply calls from traces. */
export const REPLY_TOOL_NAME = "reply";

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

		const outbound = await prepareAssistantOutbound({
			context,
			content,
			kind: "reply",
			logPrefix: "[reply]",
			...(messageRef ? { messageRef } : {}),
		});
		if ("error" in outbound) return outbound;

		const quotedPart = outbound.quoted ? { quoted: outbound.quoted } : {};
		const userFacingContent = formatUserFacingAgentMessage(content, context);
		const useVoice =
			!context.config?.suppressVoice && (voice || context.config?.forceVoice);
		if (useVoice) {
			const audio = await textToSpeech(content);
			if (audio instanceof Error) {
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
				enqueueMessage(
					{
						chatId: context.chatId,
						content: audio,
						mimeType: "audio/mpeg",
						dedupKey: makeDedupKey(context, "reply-voice"),
						label: context.agent.name,
						...quotedPart,
					},
					outbound.onSent,
				);
			}
		} else {
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
	/**
	 * Under sim, never enqueue a real WhatsApp send. But if this is an
	 * inline-dispatched child whose reply is being collected by the parent,
	 * still push into the collector so the parent agent sees the simulated
	 * reply text in its dispatch result.
	 */
	simulate: async ({ content }, context) => {
		if (context._replyCollector) {
			context._replyCollector.push(content);
			return "sent";
		}
		return "(sim) reply not sent";
	},
	sideEffect: "external",
	kind: "builtin",
	capability: "tool",
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
