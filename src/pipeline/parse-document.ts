import { existsSync } from "node:fs";
import { LiteParse } from "@llamaindex/liteparse";
import { settings } from "@/config";
import { log } from "@/logger";

const SUPPORTED_MIMES = new Set([
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
	"application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
	"application/msword",
	"application/vnd.ms-excel",
	"application/vnd.ms-powerpoint",
]);

export function isParseableDocument(mimeType: string): boolean {
	return SUPPORTED_MIMES.has(mimeType);
}

let _parser: LiteParse | null = null;
function getParser(): LiteParse {
	if (!_parser) {
		_parser = new LiteParse({
			ocrEnabled: settings.document.ocrEnabled,
			outputFormat: "text",
		});
	}
	return _parser;
}

function sidecarPath(filePath: string): string {
	return `${filePath}.parsed.txt`;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n…[truncated: ${text.length - max} chars omitted]`;
}

/**
 * Parse a document file into plain text. Caches the result in a `.parsed.txt`
 * sidecar next to the original file so repeated calls (e.g. /retry, files.read)
 * don't re-parse.
 */
export async function parseDocument(
	filePath: string,
	mimeType: string,
): Promise<string | Error> {
	if (!isParseableDocument(mimeType)) {
		return new Error(`Unsupported mime type for parsing: ${mimeType}`);
	}

	const cachePath = sidecarPath(filePath);
	if (existsSync(cachePath)) {
		try {
			return await Bun.file(cachePath).text();
		} catch (err) {
			log.warn("[parse-document] cache read failed, reparsing", {
				cachePath,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	try {
		const result = await getParser().parse(filePath);
		const text = truncate(result.text.trim(), settings.document.maxChars);
		await Bun.write(cachePath, text);
		return text;
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		log.warn("[parse-document] parse failed", {
			filePath,
			mimeType,
			error: error.message,
		});
		return error;
	}
}

/** Test-only — drop the parser singleton so a fresh config picks up. */
export function _resetParserForTest(): void {
	_parser = null;
}
