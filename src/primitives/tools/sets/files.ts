import { unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { settings } from "@/infra/config";
import { log } from "@/infra/logger";
import { getOverlay } from "@/infra/simulation";
import {
	deleteFile,
	type FileMeta,
	findFile,
	listFiles,
	persistFileBlob,
} from "@/infra/store/files";
import type { TurnContext } from "@/pipeline/core";
import { isParseableDocument, parseDocument } from "@/pipeline/media";
import type { ToolDefinition, ToolsetDefinition } from "@/primitives/tools";

const fileIdPattern = /^[0-9a-f-]{36}$/i;

function findRequestedFile(name: string): FileMeta | null {
	return fileIdPattern.test(name)
		? findFile(name)
		: (listFiles(name)[0] ?? null);
}

function matchesFileRequest(file: FileMeta, name: string): boolean {
	return fileIdPattern.test(name)
		? file.id === name
		: path.basename(file.path).includes(name);
}

function findUploadedFile(
	files: FileMeta[],
	name: string,
): FileMeta | undefined {
	return files.find((f) => matchesFileRequest(f, name));
}

function simulatedReadBlocker(
	name: string,
	context: TurnContext,
): string | null {
	const overlay = getOverlay(context);
	const simHit = findUploadedFile(overlay.uploadedFiles, name);
	if (simHit) {
		return `(sim) File was sim-uploaded this turn — content not materialized to disk.`;
	}

	const realHit = findRequestedFile(name);
	if (!realHit) return `No file found for: ${name}`;
	if (overlay.deletedFileIds.has(realHit.id)) {
		return `(sim) File ${name} was sim-deleted earlier this turn.`;
	}

	return null;
}

// ─── upload ───────────────────────────────────────────────────────────────────

const filesUploadSchema = z.object({
	name: z.string(),
	content: z.string().describe("Base64-encoded file content"),
	mimeType: z.string(),
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
	simulate: async ({ name, content, mimeType }, context) => {
		const id = crypto.randomUUID();
		const bytes = Buffer.from(content, "base64");
		const date = new Date().toISOString().slice(0, 10);
		const ext = name.includes(".") ? (name.split(".").pop() ?? "bin") : "bin";
		const virtualPath = path.join(
			settings.dataDir,
			"files",
			date,
			`${id}.${ext}`,
		);
		const meta: FileMeta = {
			id,
			path: virtualPath,
			mimeType,
			sizeBytes: bytes.byteLength,
			createdAt: new Date().toISOString(),
		};
		getOverlay(context).uploadedFiles.push(meta);
		return `(sim) Uploaded ${name} — fileId: ${id}`;
	},
	sideEffect: "stateful",
	kind: "builtin",
	capability: "tool",
};

// ─── download ─────────────────────────────────────────────────────────────────

const filesDownloadSchema = z.object({
	name: z.string().describe("File UUID or partial filename to match"),
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
			const bytes = await Bun.file(meta.path).arrayBuffer();
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
	simulate: async ({ name }, context) => {
		const blocker = simulatedReadBlocker(name, context);
		if (blocker) return blocker;
		return filesDownloadTool.execute({ name }, context);
	},
	sideEffect: "pure",
	kind: "builtin",
	capability: "resource",
};

// ─── read ─────────────────────────────────────────────────────────────────────

const filesReadSchema = z.object({
	name: z.string().describe("File UUID or partial filename to match"),
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
				return await Bun.file(meta.path).text();
			} catch (err) {
				return `Failed to read file: ${err instanceof Error ? err.message : String(err)}`;
			}
		}

		if (meta.mimeType.startsWith("image/")) {
			return `${path.basename(meta.path)} is an image (${meta.mimeType}). Use files_download to retrieve its bytes.`;
		}

		return `Cannot read ${path.basename(meta.path)} — unsupported mime type ${meta.mimeType}. Use files_download for binary content.`;
	},
	simulate: async ({ name }, context) => {
		const blocker = simulatedReadBlocker(name, context);
		if (blocker) return blocker;
		return filesReadTool.execute({ name }, context);
	},
	sideEffect: "pure",
	kind: "builtin",
	capability: "resource",
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
	simulate: async ({ prefix }, context) => {
		const overlay = getOverlay(context);
		const realRows = listFiles(prefix).filter(
			(r) => !overlay.deletedFileIds.has(r.id),
		);
		const simRows = overlay.uploadedFiles.filter((f) => {
			if (!prefix) return true;
			return (
				f.path.includes(prefix) ||
				f.id.includes(prefix) ||
				path.basename(f.path).includes(prefix)
			);
		});
		const rows = [...realRows, ...simRows];
		if (rows.length === 0) return "No files found.";
		return rows
			.map(
				(r) =>
					`${r.id}${overlay.uploadedFiles.includes(r) ? " (sim)" : ""} | ${path.basename(
						r.path,
					)} | ${r.mimeType} | ${r.sizeBytes}B | ${r.createdAt}`,
			)
			.join("\n");
	},
	sideEffect: "pure",
	kind: "builtin",
	capability: "resource",
};

// ─── delete ───────────────────────────────────────────────────────────────────

const filesDeleteSchema = z.object({
	name: z.string().describe("File UUID or partial filename to match"),
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
	simulate: async ({ name }, context) => {
		const overlay = getOverlay(context);
		const simIdx = overlay.uploadedFiles.findIndex((f) =>
			matchesFileRequest(f, name),
		);
		if (simIdx >= 0) {
			const removed = overlay.uploadedFiles.splice(simIdx, 1)[0];
			if (removed) {
				return `(sim) Deleted sim-uploaded file ${path.basename(removed.path)} (${removed.id})`;
			}
		}
		const real = findRequestedFile(name);
		if (!real) return `No file found for: ${name}`;
		overlay.deletedFileIds.add(real.id);
		return `(sim) Would delete ${path.basename(real.path)} (${real.id})`;
	},
	sideEffect: "stateful",
	kind: "builtin",
	capability: "tool",
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
