import { existsSync } from "node:fs";
import { LiteParse } from "@llamaindex/liteparse";
import { parseHTML } from "linkedom";
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

// ─── Web link fetching ───────────────────────────────────────────────────────

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

/** Strip trailing punctuation and fix unbalanced parens/brackets. */
function cleanUrl(raw: string): string {
	let url = raw.replace(/[.,;:!?]+$/, "");
	// Strip trailing ) only if parens are unbalanced (more close than open)
	while (url.endsWith(")") && count(url, "(") < count(url, ")")) {
		url = url.slice(0, -1);
	}
	while (url.endsWith("]") && count(url, "[") < count(url, "]")) {
		url = url.slice(0, -1);
	}
	return url;
}

function count(s: string, ch: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
	return n;
}

/** Extract deduplicated URLs from message text, preserving order. */
export function extractUrls(text: string): string[] {
	const matches = text.match(URL_PATTERN);
	if (!matches) return [];
	const cleaned = matches.map(cleanUrl).filter((u) => u.length > 10);
	return [...new Set(cleaned)];
}

const webCache = new Map<
	string,
	{ title: string; text: string; fetchedAt: number }
>();
const CACHE_TTL_MS = 3_600_000; // 1 hour

/**
 * Fetch a URL and extract its readable text content via defuddle.
 * Returns `{ title, text }` on success or an `Error` on failure.
 * Results are cached in-memory for 1 hour.
 */
export async function fetchWebContent(
	url: string,
): Promise<{ title: string; text: string } | Error> {
	const cached = webCache.get(url);
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return { title: cached.title, text: cached.text };
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			settings.web.timeoutMs,
		);

		const response = await fetch(url, {
			signal: controller.signal,
			headers: { "User-Agent": "Klaus/0.2 (link preview)" },
			redirect: "follow",
		});
		clearTimeout(timeout);

		if (!response.ok) {
			return new Error(`HTTP ${response.status} for ${url}`);
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (
			!contentType.includes("text/html") &&
			!contentType.includes("text/plain")
		) {
			return new Error(`Non-text content type: ${contentType}`);
		}

		// Stream body with size limit
		const reader = response.body?.getReader();
		if (!reader) return new Error("No response body");

		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > settings.web.maxBodyBytes) {
				reader.cancel();
				return new Error(
					`Response too large (>${settings.web.maxBodyBytes} bytes)`,
				);
			}
			chunks.push(value);
		}

		const body = new TextDecoder().decode(Buffer.concat(chunks));

		// Plain text — skip defuddle
		if (contentType.includes("text/plain")) {
			const text = truncate(body.trim(), settings.web.maxChars);
			const result = { title: url, text };
			webCache.set(url, { ...result, fetchedAt: Date.now() });
			return result;
		}

		// HTML — parse with defuddle
		const { Defuddle } = await import("defuddle/node");
		const { document } = parseHTML(body);
		const parsed = await Defuddle(document, url, { markdown: true });
		const text = truncate(
			(parsed.content ?? parsed.title ?? "").trim(),
			settings.web.maxChars,
		);
		const title = parsed.title ?? url;

		const result = { title, text };
		webCache.set(url, { ...result, fetchedAt: Date.now() });
		return result;
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			return new Error(`Fetch timed out for ${url}`);
		}
		return err instanceof Error ? err : new Error(String(err));
	}
}
