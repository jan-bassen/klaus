import { unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { log } from "../../../infra/logger.ts";
import { readArrayBuffer, readText } from "../../../infra/runtime.ts";
import {
	deleteFile,
	type FileMeta,
	findFile,
	listFiles,
	persistFileBlob,
} from "../../../infra/store/files.ts";
import { isParseableDocument, parseDocument } from "../../../pipeline/media.ts";
import type { ToolDefinition, ToolsetDefinition } from "../index.ts";

const fileIdPattern = /^[0-9a-f-]{36}$/i;

function findRequestedFile(name: string): FileMeta | null {
	return fileIdPattern.test(name)
		? findFile(name)
		: (listFiles(name)[0] ?? null);
}

// ─── upload ───────────────────────────────────────────────────────────────────

const filesUploadSchema = z.object({
	name: z
		.string({ error: "name must be the filename to store." })
		.min(1, { error: "name must be the filename to store." }),
	content: z
		.string({ error: "content must be base64-encoded file content." })
		.min(1, { error: "content must be base64-encoded file content." })
		.describe("Base64-encoded file content"),
	mimeType: z
		.string({ error: "mimeType must identify the uploaded file type." })
		.min(1, { error: "mimeType must identify the uploaded file type." }),
});

export const filesUploadTool: ToolDefinition<typeof filesUploadSchema> = {
	name: "files_upload",
	description:
		"Upload a file to the files directory and create a metadata entry.",
	inputSchema: filesUploadSchema,
	execute: async ({ name, content, mimeType }, _context) => {
		const bytes = Buffer.from(content, "base64");
		const saved = await persistFileBlob({
			bytes,
			mimeType,
			name,
		});

		if (saved instanceof Error) return `Upload failed: ${saved.message}`;
		if (!saved.metadataSaved) return `Upload metadata failed for ${name}`;
		return `Uploaded ${name} — fileId: ${saved.id}`;
	},
};

// ─── download ─────────────────────────────────────────────────────────────────

const filesDownloadSchema = z.object({
	name: z
		.string({ error: "name must be a file UUID or partial filename." })
		.min(1, { error: "name must be a file UUID or partial filename." })
		.describe("File UUID or partial filename to match"),
});

export const filesDownloadTool: ToolDefinition<typeof filesDownloadSchema> = {
	name: "files_download",
	description:
		"Download a file by UUID or partial filename. Returns base64-encoded content.",
	inputSchema: filesDownloadSchema,
	execute: async ({ name }, _context) => {
		const meta = findRequestedFile(name);

		if (!meta) return `No file found for: ${name}`;

		try {
			const bytes = await readArrayBuffer(meta.path);
			return {
				fileId: meta.id,
				mimeType: meta.mimeType,
				sizeBytes: meta.sizeBytes,
				content: Buffer.from(bytes).toString("base64"),
			};
		} catch (err) {
			return `Failed to read file: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
};

// ─── read ─────────────────────────────────────────────────────────────────────

const filesReadSchema = z.object({
	name: z
		.string({ error: "name must be a file UUID or partial filename." })
		.min(1, { error: "name must be a file UUID or partial filename." })
		.describe("File UUID or partial filename to match"),
});

export const filesReadTool: ToolDefinition<typeof filesReadSchema> = {
	name: "files_read",
	description:
		"Read a file's text content. Parses PDFs, docx, xlsx, pptx to plain text; returns text files directly. For images, use files_download.",
	inputSchema: filesReadSchema,
	execute: async ({ name }, _context) => {
		const meta = findRequestedFile(name);

		if (!meta) return `No file found for: ${name}`;

		if (isParseableDocument(meta.mimeType)) {
			const text = await parseDocument(meta.path, meta.mimeType);
			if (text instanceof Error) return `Parse failed: ${text.message}`;
			return text;
		}

		if (meta.mimeType.startsWith("text/")) {
			try {
				return await readText(meta.path);
			} catch (err) {
				return `Failed to read file: ${err instanceof Error ? err.message : String(err)}`;
			}
		}

		if (meta.mimeType.startsWith("image/")) {
			return `${path.basename(meta.path)} is an image (${meta.mimeType}). Use files_download to retrieve its bytes.`;
		}

		return `Cannot read ${path.basename(meta.path)} — unsupported mime type ${meta.mimeType}. Use files_download for binary content.`;
	},
};

// ─── list ─────────────────────────────────────────────────────────────────────

const filesListSchema = z.object({
	prefix: z
		.string()
		.optional()
		.describe("Optional filter — matches against filename or path"),
});

export const filesListTool: ToolDefinition<typeof filesListSchema> = {
	name: "files_list",
	description: "List files. Optionally filter by name prefix.",
	inputSchema: filesListSchema,
	execute: async ({ prefix }, _context) => {
		const rows = listFiles(prefix);

		if (rows.length === 0) return "No files found.";
		return rows
			.map(
				(r) =>
					`${r.id} | ${path.basename(r.path)} | ${r.mimeType} | ${r.sizeBytes}B | ${r.createdAt}`,
			)
			.join("\n");
	},
};

// ─── delete ───────────────────────────────────────────────────────────────────

const filesDeleteSchema = z.object({
	name: z
		.string({ error: "name must be a file UUID or partial filename." })
		.min(1, { error: "name must be a file UUID or partial filename." })
		.describe("File UUID or partial filename to match"),
});

export const filesDeleteTool: ToolDefinition<typeof filesDeleteSchema> = {
	name: "files_delete",
	description: "Delete a file — removes both the blob and its metadata.",
	inputSchema: filesDeleteSchema,
	execute: async ({ name }, _context) => {
		const meta = findRequestedFile(name);

		if (!meta) return `No file found for: ${name}`;

		try {
			await unlink(meta.path);
		} catch (err) {
			log.warn(`[files] delete failed: ${meta.path}`, {
				error: String(err),
			});
		}

		deleteFile(meta.id);
		return `Deleted ${path.basename(meta.path)} (${meta.id})`;
	},
};

export const filesToolset: ToolsetDefinition = {
	name: "files",
	description:
		"Use when you need to upload, download, read, list, or delete files.",
	tools: [
		filesUploadTool,
		filesDownloadTool,
		filesReadTool,
		filesListTool,
		filesDeleteTool,
	],
};
