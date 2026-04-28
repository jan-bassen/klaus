import { settings } from "../../infra/config.ts";
import { log } from "../../infra/logger.ts";
import { persistFileBlob } from "../../infra/store/files.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import { generateImage } from "../../pipeline/media.ts";
import type { Command } from "./index.ts";

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

		const saved = await persistFileBlob({
			bytes: result.bytes,
			mimeType: result.mimeType,
		});
		if (saved instanceof Error || !saved.metadataSaved) {
			log.warn("[/image] failed to save metadata", {
				error: saved instanceof Error ? saved.message : undefined,
				path: saved instanceof Error ? undefined : saved.path,
			});
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
