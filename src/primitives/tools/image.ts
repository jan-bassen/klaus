import { z } from "zod";
import { log } from "../../infra/logger.ts";
import { getOverlay } from "../../infra/simulation.ts";
import { persistFileBlob } from "../../infra/store/files.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import { generateImage } from "../../pipeline/media.ts";
import { prepareAssistantOutbound } from "../../pipeline/outbound.ts";
import type { ToolDefinition } from "./index.ts";

const imageGenerateSchema = z.object({
	prompt: z.string().describe("Description of the image to generate."),
	messageRef: z
		.string()
		.optional()
		.describe(
			'Message label from history (e.g. "3") or "current" to quote-reply with the image.',
		),
});

export const imageGenerateTool: ToolDefinition<typeof imageGenerateSchema> = {
	name: "image_generate",
	description:
		"Generate an image from a text prompt and send it to the user as a WhatsApp message. Returns the saved fileId.",
	inputSchema: imageGenerateSchema,
	execute: async ({ prompt, messageRef }, context) => {
		// Inline dispatch: surface a short description to the parent and skip the real send.
		if (context._replyCollector) {
			context._replyCollector.push(`[image: ${prompt}]`);
			return { sent: true, fileId: null };
		}

		const result = await generateImage({ prompt });
		if (result instanceof Error) {
			log.warn("[image_generate] failed", { error: result.message });
			return { error: result.message };
		}

		const saved = await persistFileBlob({
			bytes: result.bytes,
			mimeType: result.mimeType,
		});
		if (saved instanceof Error) {
			return { error: `Failed to save image: ${saved.message}` };
		}
		if (!saved.metadataSaved) {
			log.warn("[image_generate] failed to save metadata", {
				path: saved.path,
			});
		}

		const outbound = await prepareAssistantOutbound({
			context,
			content: `[image: ${prompt}]`,
			kind: "image",
			logPrefix: "[image_generate]",
			...(messageRef ? { messageRef } : {}),
		});
		if ("error" in outbound) return outbound;

		enqueueMessage(
			{
				chatId: context.chatId,
				content: result.bytes,
				mimeType: result.mimeType,
				dedupKey: outbound.dedupKey,
				label: context.agent.name,
				...(outbound.quoted ? { quoted: outbound.quoted } : {}),
			},
			outbound.onSent,
		);

		return { sent: true, fileId: saved.id };
	},
	simulate: async ({ prompt }, context) => {
		if (context._replyCollector) {
			context._replyCollector.push(`[image: ${prompt}]`);
		}
		const overlay = getOverlay(context);
		overlay.actions.push({
			tool: "image_generate",
			sideEffect: "external",
			args: { prompt },
			intent: `Would generate and send image: "${prompt.slice(0, 80)}${
				prompt.length > 80 ? "…" : ""
			}"`,
			result: { sent: true, fileId: null },
		});
		return { sent: true, fileId: null, simulated: true };
	},
	sideEffect: "external",
	kind: "builtin",
	capability: "tool",
};
