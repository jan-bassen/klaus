import { z } from "zod";
import { log } from "../../infra/logger.ts";
import { readArrayBuffer } from "../../infra/runtime.ts";
import { getOverlay } from "../../infra/simulation.ts";
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
		.string()
		.optional()
		.describe(
			'Message label from history (e.g. "3") or "current" — uses the image attached to that message as input.',
		),
	messageRef: z
		.string()
		.optional()
		.describe(
			'Message label from history (e.g. "3") or "current" to quote-reply with the image.',
		),
});

async function resolveSourceImages(
	context: TurnContext,
	fileIds: string[] | undefined,
	messageRef: string | undefined,
): Promise<Array<{ bytes: Buffer; mimeType: string }> | Error> {
	const out: Array<{ bytes: Buffer; mimeType: string }> = [];

	for (const id of fileIds ?? []) {
		const meta = findFile(id);
		if (!meta) return new Error(`Source file not found: ${id}`);
		const bytes = Buffer.from(await readArrayBuffer(meta.path));
		out.push({ bytes, mimeType: meta.mimeType });
	}

	if (messageRef) {
		const externalId =
			messageRef === "current"
				? context.message?.id
				: context.messageRefs?.[messageRef]?.externalId;
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
	simulate: async ({ prompt, sourceFileIds, sourceMessageRef }, context) => {
		if (context._replyCollector) {
			context._replyCollector.push(`[image: ${prompt}]`);
		}
		const sourceCount =
			(sourceFileIds?.length ?? 0) + (sourceMessageRef ? 1 : 0);
		const verb = sourceCount > 0 ? "edit" : "generate";
		const overlay = getOverlay(context);
		overlay.actions.push({
			tool: "image_generate",
			sideEffect: "external",
			args: { prompt, sourceFileIds, sourceMessageRef },
			intent: `Would ${verb} and send image: "${prompt.slice(0, 80)}${
				prompt.length > 80 ? "…" : ""
			}"${sourceCount ? ` (${sourceCount} source image${sourceCount > 1 ? "s" : ""})` : ""}`,
			result: { sent: true, fileId: null },
		});
		return { sent: true, fileId: null, simulated: true };
	},
	sideEffect: "external",
	kind: "builtin",
	capability: "tool",
};
