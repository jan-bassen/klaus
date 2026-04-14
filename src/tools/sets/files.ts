import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { settings } from "@/config";
import { log } from "@/logger";
import { deleteFile, findFile, listFiles, saveFileMeta } from "@/store/files";
import type { ToolDefinition, ToolsetDefinition } from "@/types";

// ─── upload ───────────────────────────────────────────────────────────────────

const filesUploadSchema = z.object({
	name: z.string(),
	content: z.string().describe("Base64-encoded file content"),
	mimeType: z.string(),
});

export const filesUploadTool: ToolDefinition<typeof filesUploadSchema> = {
	name: "files.upload",
	description:
		"Upload a file to the files directory and create a metadata entry.",
	inputSchema: filesUploadSchema,
	execute: async ({ name, content, mimeType }, _context) => {
		const bytes = Buffer.from(content, "base64");
		const date = new Date().toISOString().slice(0, 10);
		const ext = name.includes(".") ? (name.split(".").pop() ?? "bin") : "bin";
		const id = crypto.randomUUID();
		const dir = path.join(settings.dataDir, "files", date);
		const filePath = path.join(dir, `${id}.${ext}`);

		await mkdir(dir, { recursive: true });
		await Bun.write(filePath, bytes);

		const saved = await saveFileMeta({
			path: filePath,
			mimeType,
			sizeBytes: bytes.byteLength,
		});

		if (saved instanceof Error) return `Upload failed: ${saved.message}`;
		return `Uploaded ${name} — fileId: ${saved.id}`;
	},
	kind: "builtin",
	capability: "tool",
};

// ─── download ─────────────────────────────────────────────────────────────────

const filesDownloadSchema = z.object({
	name: z.string().describe("File UUID or partial filename to match"),
});

export const filesDownloadTool: ToolDefinition<typeof filesDownloadSchema> = {
	name: "files.download",
	description:
		"Download a file by UUID or partial filename. Returns base64-encoded content.",
	inputSchema: filesDownloadSchema,
	execute: async ({ name }, _context) => {
		const isUuid = /^[0-9a-f-]{36}$/i.test(name);
		const meta = isUuid ? findFile(name) : (listFiles(name)[0] ?? null);

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
	name: "files.list",
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
	kind: "builtin",
	capability: "resource",
};

// ─── delete ───────────────────────────────────────────────────────────────────

const filesDeleteSchema = z.object({
	name: z.string().describe("File UUID or partial filename to match"),
});

export const filesDeleteTool: ToolDefinition<typeof filesDeleteSchema> = {
	name: "files.delete",
	description: "Delete a file — removes both the blob and its metadata.",
	inputSchema: filesDeleteSchema,
	execute: async ({ name }, _context) => {
		const isUuid = /^[0-9a-f-]{36}$/i.test(name);
		const meta = isUuid ? findFile(name) : (listFiles(name)[0] ?? null);

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
	kind: "builtin",
	capability: "tool",
	requiresConfirmation: true,
};

export const filesToolset: ToolsetDefinition = {
	name: "files",
	description: "Use when you need to upload, download, list, or delete files.",
	tools: [filesUploadTool, filesDownloadTool, filesListTool, filesDeleteTool],
};
