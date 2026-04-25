import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { settings } from "@/infra/config";
import { log } from "@/infra/logger";
import { getOverlay } from "@/infra/simulation";
import { saveFileMeta } from "@/infra/store/files";
import { appendAck, appendMessage } from "@/infra/store/history";
import { enqueueMessage } from "@/infra/whatsapp/send";
import { generateImage } from "@/pipeline/imagegen";
import type { ToolDefinition } from "@/primitives/tools";

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

		// Persist bytes
		const ext = mimeToExt(result.mimeType);
		const id = crypto.randomUUID();
		const date = new Date().toISOString().slice(0, 10);
		const dir = path.join(settings.dataDir, "files", date);
		const filePath = path.join(dir, `${id}.${ext}`);
		await mkdir(dir, { recursive: true });
		await Bun.write(filePath, result.bytes);

		const saved = await saveFileMeta({
			path: filePath,
			mimeType: result.mimeType,
			sizeBytes: result.bytes.byteLength,
		});
		if (saved instanceof Error) {
			return { error: `Failed to save image: ${saved.message}` };
		}

		// Resolve quote target
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
				ref = context.messageRefs?.[messageRef];
			}
			if (!ref) return { error: `Unknown message reference: #${messageRef}` };
			quoted = { externalId: ref.externalId, fromMe: ref.role !== "user" };
		}

		// Persist as text-only assistant row so it shows up in history transcripts
		// without auto-loading the bytes into the next turn's multimodal context.
		let rowId: string | undefined;
		if (!context.config?.ghost) {
			try {
				rowId = await appendMessage({
					role: "assistant",
					content: `[image: ${prompt}]`,
					agent: context.agent.name,
					runId: context.runId,
				});
			} catch (err) {
				log.warn("[image_generate] failed to persist assistant message", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		const onSent = rowId
			? (waId: string) => {
					appendAck(rowId, waId).catch((err: unknown) => {
						log.warn("[image_generate] failed to backfill externalId", {
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
			: undefined;

		const dedupBase = context.message
			? `${context.message.id}:image:${crypto.randomUUID()}`
			: `${context.chatId}:image:${crypto.randomUUID()}`;

		enqueueMessage(
			{
				chatId: context.chatId,
				content: result.bytes,
				mimeType: result.mimeType,
				dedupKey: dedupBase,
				label: context.agent.name,
				...(quoted ? { quoted } : {}),
			},
			onSent,
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

function mimeToExt(mime: string): string {
	if (mime === "image/png") return "png";
	if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
	if (mime === "image/webp") return "webp";
	if (mime === "image/gif") return "gif";
	return "bin";
}
