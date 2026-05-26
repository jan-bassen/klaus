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

const imageGenerateSchema = z.object({
	prompt: z
		.string()
		.describe(
			"Description of the image to generate, or edit instructions when source images are provided.",
		),
	sourceFileIds: z
		.array(z.string())
		.optional()
		.describe(
			"File IDs of input images to edit or use as visual context. Combine with prompt for edits, style transfer, or composition.",
		),
	sourceMessageRef: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe(
			"Integer message label for an input image: 0 for the current message, or a positive history label such as 3 for an older message.",
		),
	messageRef: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe(
			"Integer message label to quote-reply with the image: 0 or omit for the current message, or a positive history label such as 3 for an older message.",
		),
});

async function resolveSourceImages(
	context: TurnContext,
	fileIds: string[] | undefined,
	messageRef: number | undefined,
): Promise<Array<{ bytes: Buffer; mimeType: string }> | Error> {
	const out: Array<{ bytes: Buffer; mimeType: string }> = [];

	for (const id of fileIds ?? []) {
		const meta = findFile(id);
		if (!meta) return new Error(`Source file not found: ${id}`);
		const bytes = Buffer.from(await readArrayBuffer(meta.path));
		out.push({ bytes, mimeType: meta.mimeType });
	}

	if (messageRef !== undefined) {
		const externalId =
			messageRef === 0
				? context.message?.id
				: context.messageRefs?.[String(messageRef)]?.externalId;
		if (!externalId) {
			return new Error(`Unknown message reference: #${messageRef}`);
		}
		const found = findFileByExternalId(externalId);
		if (!found) {
			return new Error(`No image attached to message #${messageRef}`);
		}
		const bytes = Buffer.from(await readArrayBuffer(found.path));
		out.push({ bytes, mimeType: found.mimeType });
	}

	return out;
}

export const imageGenerateTool: ToolDefinition<typeof imageGenerateSchema> = {
	name: "image_generate",
	description:
		"Generate or edit an image and send it to the user as a WhatsApp message. With no source images, generates from the prompt alone. Pass sourceFileIds and/or sourceMessageRef to edit, restyle, or compose existing images per the prompt. Returns the saved fileId.",
	inputSchema: imageGenerateSchema,
	execute: async (
		{ prompt, sourceFileIds, sourceMessageRef, messageRef },
		context,
	) => {
		// Inline dispatch: surface a short description to the parent and skip the real send.
		if (context._replyCollector) {
			context._replyCollector.push(`[image: ${prompt}]`);
			return { sent: true, fileId: null };
		}

		const sources = await resolveSourceImages(
			context,
			sourceFileIds,
			sourceMessageRef,
		);
		if (sources instanceof Error) {
			log.warn("[image_generate] failed to resolve sources", {
				error: sources.message,
			});
			return { error: sources.message };
		}

		const result = await generateImage({
			prompt,
			...(sources.length ? { images: sources } : {}),
		});
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
			...(messageRef !== undefined ? { messageRef } : {}),
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
