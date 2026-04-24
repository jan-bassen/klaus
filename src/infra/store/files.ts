import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { log } from "@/infra/logger";

export interface FileStore {
	saveFileMeta(meta: {
		path: string;
		mimeType: string;
		sizeBytes: number;
		messageId?: string;
		externalId?: string;
	}): Promise<{ id: string; path: string } | Error>;
	updateFileMessageId(
		fileId: string,
		messageId: string,
	): Promise<undefined | Error>;
	findFile(fileId: string): FileMeta | null;
	findFileByMessageId(
		messageId: string,
	): { fileId: string; path: string; mimeType: string } | null;
	findFileByExternalId(
		externalId: string,
	): { fileId: string; path: string; mimeType: string } | null;
	listFiles(prefix?: string): FileMeta[];
	deleteFile(fileId: string): boolean;
	rebuildIndex(): Promise<void>;
}

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

export interface FileStoreEnv {
	dataDir: string;
}

export function createFileStore(env: FileStoreEnv): FileStore {
	const fileIndex = new Map<string, FileMeta>();
	const messageFileIndex = new Map<string, string>();
	const externalFileIndex = new Map<string, string>();

	const filesDir = (): string => path.join(env.dataDir, "files");
	const indexPath = (): string => path.join(filesDir(), "files-index.jsonl");

	async function saveFileMeta(meta: {
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

	async function updateFileMessageId(
		fileId: string,
		messageId: string,
	): Promise<undefined | Error> {
		const meta = fileIndex.get(fileId);
		if (!meta) return new Error(`File not found: ${fileId}`);
		meta.messageId = messageId;
		messageFileIndex.set(messageId, fileId);
		try {
			await appendFile(
				indexPath(),
				`${JSON.stringify({ ...meta, _update: true })}\n`,
			);
		} catch (err) {
			return err instanceof Error ? err : new Error(String(err));
		}
	}

	function findFile(fileId: string): FileMeta | null {
		return fileIndex.get(fileId) ?? null;
	}

	function findFileByMessageId(
		messageId: string,
	): { fileId: string; path: string; mimeType: string } | null {
		const fileId = messageFileIndex.get(messageId);
		if (!fileId) return null;
		const meta = fileIndex.get(fileId);
		if (!meta) return null;
		return { fileId: meta.id, path: meta.path, mimeType: meta.mimeType };
	}

	function findFileByExternalId(
		externalId: string,
	): { fileId: string; path: string; mimeType: string } | null {
		const fileId = externalFileIndex.get(externalId);
		if (!fileId) return null;
		const meta = fileIndex.get(fileId);
		if (!meta) return null;
		return { fileId: meta.id, path: meta.path, mimeType: meta.mimeType };
	}

	function listFiles(prefix?: string): FileMeta[] {
		const all = [...fileIndex.values()];
		if (!prefix) return all;
		return all.filter((f) => f.path.startsWith(prefix));
	}

	function deleteFile(fileId: string): boolean {
		const meta = fileIndex.get(fileId);
		if (!meta) return false;
		fileIndex.delete(fileId);
		if (meta.messageId) messageFileIndex.delete(meta.messageId);
		if (meta.externalId) externalFileIndex.delete(meta.externalId);
		return true;
	}

	async function rebuildIndex(): Promise<void> {
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
					fileIndex.set(record.id, {
						id: record.id,
						path: record.path,
						mimeType: record.mimeType,
						sizeBytes: record.sizeBytes,
						...(record.messageId ? { messageId: record.messageId } : {}),
						...(record.externalId ? { externalId: record.externalId } : {}),
						createdAt: record.createdAt,
					});
					if (record.messageId)
						messageFileIndex.set(record.messageId, record.id);
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

		log.info(`[files] index rebuilt (${fileIndex.size} files)`);
	}

	return {
		saveFileMeta,
		updateFileMessageId,
		findFile,
		findFileByMessageId,
		findFileByExternalId,
		listFiles,
		deleteFile,
		rebuildIndex,
	};
}

// ── Module-level instance + delegators ────────────────────────────────────

let _store: FileStore | null = null;

export function initFilesStore(env: FileStoreEnv): void {
	_store = createFileStore(env);
}

function store(): FileStore {
	if (!_store) throw new Error("[files] store not initialized");
	return _store;
}

export function saveFileMeta(meta: {
	path: string;
	mimeType: string;
	sizeBytes: number;
	messageId?: string;
	externalId?: string;
}): Promise<{ id: string; path: string } | Error> {
	return store().saveFileMeta(meta);
}

export function updateFileMessageId(
	fileId: string,
	messageId: string,
): Promise<undefined | Error> {
	return store().updateFileMessageId(fileId, messageId);
}

export function findFile(fileId: string): FileMeta | null {
	return store().findFile(fileId);
}

export function findFileByMessageId(
	messageId: string,
): { fileId: string; path: string; mimeType: string } | null {
	return store().findFileByMessageId(messageId);
}

export function findFileByExternalId(
	externalId: string,
): { fileId: string; path: string; mimeType: string } | null {
	return store().findFileByExternalId(externalId);
}

export function listFiles(prefix?: string): FileMeta[] {
	return store().listFiles(prefix);
}

export function deleteFile(fileId: string): boolean {
	return store().deleteFile(fileId);
}

export function rebuildFileIndex(): Promise<void> {
	return store().rebuildIndex();
}
