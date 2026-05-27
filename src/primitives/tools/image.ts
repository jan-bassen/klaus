import { z } from "zod";
import { log } from "../../infra/logger.ts";
import { readArrayBuffer } from "../../infra/runtime.ts";
import {
	findFile,
	findFileByExternalId,
	persistFileBlob,
} from "../../infra/store/files.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import type { TurnContext } from "../../pipeline/core.ts";
import { generateImage } from "../../pipeline/media.ts";
import { prepareAssistantOutbound } from "../../pipeline/outbound.ts";
import type { ToolDefinition } from "./index.ts";

const sendImageSchema = z.object({
	prompt: z
		.string({ error: "Describe the image to generate or edit in prompt." })
		.min(1, { error: "Describe the image to generate or edit in prompt." })
		.describe(
			"Description of the image to generate, or edit instructions when source images are provided.",
		),
	inputFileIds: z
		.array(z.string())
		.optional()
		.describe(
			"File IDs of input images to edit or use as visual context. Combine with prompt for edits, style transfer, or composition.",
		),
	inputMessageLabel: z
		.number({
			error:
				"inputMessageLabel must be an integer message label, not a string.",
		})
		.int({
			error:
				"inputMessageLabel must be an integer message label, not a string.",
		})
		.nonnegative({
			error:
				"inputMessageLabel must be 0 for the current message or a positive visible message label.",
		})
		.optional()
		.describe(
			"Visible message label for an input image. Use 0 for the current message, or a positive [#n] history label.",
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
			"Visible message label to quote in WhatsApp. Use only positive [#n] history labels for older messages. Omit for normal image messages; 0 is accepted but ignored.",
		),
});

async function resolveSourceImages(
	context: TurnContext,
	fileIds: string[] | undefined,
	messageLabel: number | undefined,
): Promise<Array<{ bytes: Buffer; mimeType: string }> | Error> {
	const out: Array<{ bytes: Buffer; mimeType: string }> = [];

	for (const id of fileIds ?? []) {
		const meta = findFile(id);
		if (!meta) return new Error(`Source file not found: ${id}`);
		const bytes = Buffer.from(await readArrayBuffer(meta.path));
		out.push({ bytes, mimeType: meta.mimeType });
	}

	if (messageLabel !== undefined) {
		const externalId =
			messageLabel === 0
				? context.message?.id
				: context.messageRefs?.[String(messageLabel)]?.externalId;
		if (!externalId) {
			return new Error(`Unknown message label: #${messageLabel}`);
		}
		const found = findFileByExternalId(externalId);
		if (!found) {
			return new Error(`No image attached to message #${messageLabel}`);
		}
		const bytes = Buffer.from(await readArrayBuffer(found.path));
		out.push({ bytes, mimeType: found.mimeType });
	}

	return out;
}

export const sendImageTool: ToolDefinition<typeof sendImageSchema> = {
	name: "send_image",
	description:
		"Generate or edit an image and send it as a WhatsApp message. With no input images, generates from the prompt alone. Returns the saved fileId.",
	inputSchema: sendImageSchema,
	execute: async (
		{ prompt, inputFileIds, inputMessageLabel, quoteMessageLabel },
		context,
	) => {
		// Inline agent runs return a short description to their caller instead of sending to WhatsApp.
		if (context._replyCollector) {
			context._replyCollector.push(`[image: ${prompt}]`);
			return { sent: true, fileId: null };
		}

		const sources = await resolveSourceImages(
			context,
			inputFileIds,
			inputMessageLabel,
		);
		if (sources instanceof Error) {
			log.warn("[send_image] failed to resolve sources", {
				error: sources.message,
			});
			return { error: sources.message };
		}

		const result = await generateImage({
			prompt,
			...(sources.length ? { images: sources } : {}),
		});
		if (result instanceof Error) {
			log.warn("[send_image] failed", { error: result.message });
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
			log.warn("[send_image] failed to save metadata", {
				path: saved.path,
			});
		}

		const outbound = await prepareAssistantOutbound({
			context,
			content: `[image: ${prompt}]`,
			kind: "image",
			logPrefix: "[send_image]",
			...(quoteMessageLabel !== undefined
				? { messageRef: quoteMessageLabel }
				: {}),
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
};
