import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { log } from "@/logger";
import { settings } from "@/settings";

export const FileMetaSchema = z.object({
	id: z.string(),
	path: z.string(),
	mimeType: z.string(),
	sizeBytes: z.number(),
	messageId: z.string().optional(),
	externalId: z.string().optional(),
	createdAt: z.string(),
});

export type FileMeta = z.infer<typeof FileMetaSchema>;

/** In-memory index: fileId → FileMeta */
const fileIndex = new Map<string, FileMeta>();
/** Reverse index: messageId → fileId */
const messageFileIndex = new Map<string, string>();
/** Reverse index: externalId → fileId */
const externalFileIndex = new Map<string, string>();

function filesDir(): string {
	return path.join(settings.dataDir, "files");
}

function indexPath(): string {
	return path.join(filesDir(), "files-index.jsonl");
}

/** Save file metadata to the index. Returns the file record. */
export async function saveFileMeta(meta: {
	path: string;
	mimeType: string;
	sizeBytes: number;
	messageId?: string;
	externalId?: string;
}): Promise<{ id: string; path: string } | Error> {
	try {
		await mkdir(filesDir(), { recursive: true });
		const id = crypto.randomUUID();
		const record: FileMeta = {
			id,
			path: meta.path,
			mimeType: meta.mimeType,
			sizeBytes: meta.sizeBytes,
			...(meta.messageId ? { messageId: meta.messageId } : {}),
			...(meta.externalId ? { externalId: meta.externalId } : {}),
			createdAt: new Date().toISOString(),
		};
		await appendFile(indexPath(), `${JSON.stringify(record)}\n`);
		fileIndex.set(id, record);
		if (meta.messageId) messageFileIndex.set(meta.messageId, id);
		if (meta.externalId) externalFileIndex.set(meta.externalId, id);
		return { id, path: meta.path };
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}

/** Update the messageId for a file (backfill after message insert). */
export async function updateFileMessageId(
	fileId: string,
	messageId: string,
): Promise<undefined | Error> {
	const meta = fileIndex.get(fileId);
	if (!meta) return new Error(`File not found: ${fileId}`);
	meta.messageId = messageId;
	messageFileIndex.set(messageId, fileId);
	// Append an update record to the index
	try {
		await appendFile(
			indexPath(),
			`${JSON.stringify({ ...meta, _update: true })}\n`,
		);
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}

/** Find a file by ID. */
export function findFile(fileId: string): FileMeta | null {
	return fileIndex.get(fileId) ?? null;
}

/** Find the first image file linked to a given message. */
export function findFileByMessageId(
	messageId: string,
): { fileId: string; path: string; mimeType: string } | null {
	const fileId = messageFileIndex.get(messageId);
	if (!fileId) return null;
	const meta = fileIndex.get(fileId);
	if (!meta) return null;
	if (!meta.mimeType.startsWith("image/")) return null;
	return { fileId: meta.id, path: meta.path, mimeType: meta.mimeType };
}

/** Find the first image file linked to a given WhatsApp externalId. */
export function findFileByExternalId(
	externalId: string,
): { fileId: string; path: string; mimeType: string } | null {
	const fileId = externalFileIndex.get(externalId);
	if (!fileId) return null;
	const meta = fileIndex.get(fileId);
	if (!meta) return null;
	if (!meta.mimeType.startsWith("image/")) return null;
	return { fileId: meta.id, path: meta.path, mimeType: meta.mimeType };
}

/** List all files, optionally filtered by path prefix. */
export function listFiles(prefix?: string): FileMeta[] {
	const all = [...fileIndex.values()];
	if (!prefix) return all;
	return all.filter((f) => f.path.startsWith(prefix));
}

/** Delete a file from the index (does not remove the blob). */
export function deleteFile(fileId: string): boolean {
	const meta = fileIndex.get(fileId);
	if (!meta) return false;
	fileIndex.delete(fileId);
	if (meta.messageId) messageFileIndex.delete(meta.messageId);
	if (meta.externalId) externalFileIndex.delete(meta.externalId);
	return true;
}

/**
 * Rebuild in-memory indexes from files-index.jsonl.
 * Call once at startup.
 */
export async function rebuildFileIndex(): Promise<void> {
	fileIndex.clear();
	messageFileIndex.clear();
	externalFileIndex.clear();

	try {
		const text = await Bun.file(indexPath()).text();
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const record = FileMetaSchema.extend({
					_update: z.boolean().optional(),
				}).parse(JSON.parse(line));
				// Later entries overwrite earlier ones (handles updates)
				fileIndex.set(record.id, {
					id: record.id,
					path: record.path,
					mimeType: record.mimeType,
					sizeBytes: record.sizeBytes,
					...(record.messageId ? { messageId: record.messageId } : {}),
					...(record.externalId ? { externalId: record.externalId } : {}),
					createdAt: record.createdAt,
				});
				if (record.messageId) messageFileIndex.set(record.messageId, record.id);
				if (record.externalId)
					externalFileIndex.set(record.externalId, record.id);
			} catch {
				log.warn("[files] skipping corrupt line in index rebuild", {
					line: line.slice(0, 100),
				});
			}
		}
	} catch {
		// No index file yet
	}

	log.info("[files] index rebuilt", { files: fileIndex.size });
}

/** Clear indexes. Test-only. */
export function _clearFileIndexForTest(): void {
	fileIndex.clear();
	messageFileIndex.clear();
	externalFileIndex.clear();
}
