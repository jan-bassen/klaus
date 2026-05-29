/**
 * Single-pass normalize + parse for inbound messages.
 *
 * Normalize = turn raw inbound into a fully-enriched InboundMessage:
 *   - transcribe voice notes (STT)
 *   - parse attached documents to text
 *
 * Parse = detect `/command`, prepend any armed `/next` prefix, extract
 * `@agent` route, pull out `!overrides`.
 *
 * All lower-level media work lives in `pipeline/media.ts`; this module just
 * orchestrates and handles the message-level text munging.
 */

import { log } from "../infra/logger.ts";
import type { InboundMessage } from "../infra/whatsapp/receive.ts";
import { parseCommand } from "../primitives/commands/index.ts";
import { isParseableDocument, parseDocument, transcribe } from "./media.ts";
import { parseOverrides, stripOverrides } from "./overrides.ts";

/**
 * Result of normalizing + parsing a single inbound message.
 *
 * - `msg` is the post-STT, post-strip message (text contains only the user prompt).
 * - `cleanText` mirrors `msg.text` for callers that want it independent of msg.
 * - `command` short-circuits the pipeline: the rest of the parsed fields are absent.
 * - `agent` is the explicit `@name` route if present.
 * - `overrides` is the set of recognized `!preset` names found in the effective source text.
 */
interface ParsedMessage {
	msg: InboundMessage;
	cleanText: string;
	overrides: Record<string, boolean>;
	command?: { name: string; args: string[] };
	agent?: string;
}

/**
 * Full normalize + parse. Returns the enriched message plus the parsed
 * routing info.
 */
export async function parseMessage(
	msg: InboundMessage,
	nextPrefix?: string,
): Promise<ParsedMessage> {
	let processed = await normalize(msg);
	let sourceText = processed.text ?? "";

	const command = parseCommand(processed);
	if (command) {
		return { msg: processed, cleanText: sourceText, overrides: {}, command };
	}

	if (nextPrefix?.trim()) {
		sourceText = `${nextPrefix.trim()} ${sourceText}`.trim();
		processed = { ...processed, text: sourceText };
	}

	const routeMatch = sourceText.match(/^@([\w-]+)\s*/);
	const afterRoute = routeMatch
		? sourceText.slice(routeMatch[0].length)
		: sourceText;

	const overrides = parseOverrides({ text: afterRoute });
	const cleanText = stripOverrides(afterRoute);

	processed = { ...processed, text: cleanText };

	return {
		msg: processed,
		cleanText,
		overrides,
		...(routeMatch?.[1] ? { agent: routeMatch[1] } : {}),
	};
}

// ── Normalize (media → text) ───────────────────────────────────────────────

async function normalize(msg: InboundMessage): Promise<InboundMessage> {
	let m = msg;

	if (m.media?.mimeType.startsWith("audio/")) {
		const transcript = await transcribe(m.media.path, m.media.mimeType);
		if (transcript instanceof Error) {
			log.warn("[message] transcription failed", { error: transcript.message });
		} else {
			m = {
				...m,
				text: transcript,
				media: {
					...m.media,
					transcription: transcript,
					voiceCaption: msg.text ?? "",
				},
			};
		}
	} else if (m.media && isParseableDocument(m.media.mimeType)) {
		const extracted = await parseDocument(m.media.path, m.media.mimeType);
		if (!(extracted instanceof Error)) {
			m = { ...m, media: { ...m.media, extractedText: extracted } };
		}
	}

	return m;
}
