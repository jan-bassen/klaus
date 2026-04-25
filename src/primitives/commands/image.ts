import { mkdir } from "node:fs/promises";
import path from "node:path";
import { settings } from "@/infra/config";
import { log } from "@/infra/logger";
import { saveFileMeta } from "@/infra/store/files";
import type { InboundMessage } from "@/infra/whatsapp/receive";
import { enqueueMessage } from "@/infra/whatsapp/send";
import { generateImage } from "@/pipeline/imagegen";
import type { Command } from "@/primitives/commands";

export const imageCommand: Command = {
	name: "image",
	aliases: ["img"],
	description: "Generate an image from a prompt and send it back",
	async execute(msg: InboundMessage, args: string[]): Promise<void> {
		const prompt = args.join(" ").trim();
		if (!prompt) {
			enqueueMessage({
				chatId: msg.chatId,
				content: "Usage: /image <prompt>",
				dedupKey: `${msg.id}:image-usage`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		const result = await generateImage({ prompt });
		if (result instanceof Error) {
			log.warn("[/image] generation failed", { error: result.message });
			enqueueMessage({
				chatId: msg.chatId,
				content: `Image generation failed: ${result.message}`,
				dedupKey: `${msg.id}:image-error`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

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
			log.warn("[/image] failed to save metadata", { error: saved.message });
		}

		enqueueMessage({
			chatId: msg.chatId,
			content: result.bytes,
			mimeType: result.mimeType,
			dedupKey: `${msg.id}:image`,
			label: settings.whatsapp.systemLabel,
			quoted: { externalId: msg.id, fromMe: false },
		});
	},
};

function mimeToExt(mime: string): string {
	if (mime === "image/png") return "png";
	if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
	if (mime === "image/webp") return "webp";
	if (mime === "image/gif") return "gif";
	return "bin";
}
