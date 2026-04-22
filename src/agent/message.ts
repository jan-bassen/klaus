import { readFileSync } from "node:fs";
import type { ImagePart, TextPart, UserContent } from "ai";
import sharp from "sharp";
import { settings } from "@/config";
import { hbs, interpolateUserVars } from "@/markdown";
import type { TurnContext } from "@/types";

const MAX_IMAGE_DIMENSION = settings.vision.maxImageDimension;

function messageTemplatePath(): string {
	return `${settings.vault.internalPath}/message.md`;
}

/**
 * Render the text portion of the user message via `{vault}/Klaus/message.md`.
 * Throws if the template is missing — setup mode guides the user to create it.
 */
function buildUserMessageText(turn: TurnContext): string {
	if (!turn.message) return "";

	let templateRaw: string;
	try {
		templateRaw = readFileSync(messageTemplatePath(), "utf-8");
	} catch {
		throw new Error(
			`Missing user message template at ${messageTemplatePath()}. Create it to format inbound messages.`,
		);
	}

	const messageText = turn.message.media?.mimeType.startsWith("audio/")
		? (turn.message.media?.transcription ?? "")
		: (turn.message.text ?? "");

	const template = hbs.compile(templateRaw, { noEscape: true });
	const raw = template({
		...turn.vars,
		quotedText: turn.message.quotedMessage?.text ?? "",
		messageText,
		overrides: Object.keys(turn.overrides),
	})
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return interpolateUserVars(raw, turn.vars);
}

/**
 * Assemble the model's user-turn content:
 *   - dispatch-only turns       → the dispatch objective
 *   - vision turns (img or quoted img) → [image, text] parts
 *   - everything else           → rendered message text
 */
export async function buildUserContent(
	turn: TurnContext,
): Promise<UserContent> {
	const inboundMedia = turn.message?.media;
	const quotedMedia = turn.message?.quotedMessage?.media;
	const visionMedia = inboundMedia?.mimeType.startsWith("image/")
		? inboundMedia
		: quotedMedia?.mimeType.startsWith("image/")
			? quotedMedia
			: null;

	if (visionMedia) {
		const textContent = buildUserMessageText(turn);

		// Downscale large images to prevent token overflow (Anthropic tiles at 512×512 px, ~1500 tokens/tile)
		const rawBytes = await Bun.file(visionMedia.path).arrayBuffer();
		const resized = await sharp(Buffer.from(rawBytes))
			.resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
				fit: "inside",
				withoutEnlargement: true,
			})
			.toBuffer();

		const imagePart: ImagePart = {
			type: "image",
			image: new Uint8Array(resized),
			mediaType: visionMedia.mimeType as Exclude<
				ImagePart["mediaType"],
				undefined
			>,
		};
		return textContent
			? [imagePart, { type: "text", text: textContent } as TextPart]
			: [imagePart];
	}

	if (turn.message) return buildUserMessageText(turn);

	return turn.dispatchContext?.objective ?? "";
}
