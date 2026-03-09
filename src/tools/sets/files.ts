import path from 'path';
import { mkdir, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { eq, like } from 'drizzle-orm';
import type { ToolDefinition, ToolsetDefinition } from '@/types';
import { db } from '@/db/client';
import { files } from '@/db/schema';
import { saveFile } from '@/db/write';
import { log } from '@/logger';
import { config } from '@/config';

// ─── upload ───────────────────────────────────────────────────────────────────

const filesUploadSchema = z.object({
  name: z.string(),
  content: z.string().describe('Base64-encoded file content'),
  mimeType: z.string(),
  nodeId: z.string().uuid().optional().describe('Optional graph node to link this file to'),
});

export const filesUploadTool: ToolDefinition<typeof filesUploadSchema> = {
  name: 'files.upload',
  description: 'Upload a file to the files volume and create a metadata row in the files table. Optionally links to a graph node via nodeId.',
  inputSchema: filesUploadSchema,
  execute: async ({ name, content, mimeType, nodeId }, _context) => {
    const bytes = Buffer.from(content, 'base64');
    const date = new Date().toISOString().slice(0, 10);
    const ext = name.includes('.') ? name.split('.').pop()! : 'bin';
    const id = crypto.randomUUID();
    const dir = path.join(config.files.dir, date);
    const filePath = path.join(dir, `${id}.${ext}`);

    await mkdir(dir, { recursive: true });
    await Bun.write(filePath, bytes);

    const saved = await saveFile({
      path: filePath,
      mimeType,
      sizeBytes: bytes.byteLength,
      ...(nodeId ? { nodeId } : {}),
    });

    if (saved instanceof Error) return `Upload failed: ${saved.message}`;
    return `Uploaded ${name} — fileId: ${saved.id}`;
  },
  kind: 'builtin',
  capability: 'tool',
};

// ─── download ─────────────────────────────────────────────────────────────────

const filesDownloadSchema = z.object({
  name: z.string().describe('File UUID or partial filename to match'),
});

export const filesDownloadTool: ToolDefinition<typeof filesDownloadSchema> = {
  name: 'files.download',
  description: 'Download a file from the files volume by UUID or partial filename. Returns base64-encoded content.',
  inputSchema: filesDownloadSchema,
  execute: async ({ name }, _context) => {
    const isUuid = /^[0-9a-f-]{36}$/i.test(name);
    const rows = isUuid
      ? await db.select().from(files).where(eq(files.id, name))
      : await db.select().from(files).where(like(files.path, `%${name}%`));

    if (rows.length === 0) return `No file found for: ${name}`;
    const row = rows[0]!;

    try {
      const bytes = await Bun.file(row.path).arrayBuffer();
      return {
        fileId: row.id,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        content: Buffer.from(bytes).toString('base64'),
      };
    } catch (err) {
      return `Failed to read file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  kind: 'builtin',
  capability: 'resource',
};

// ─── list ─────────────────────────────────────────────────────────────────────

const filesListSchema = z.object({
  prefix: z.string().optional().describe('Optional filter — matches against filename or path'),
});

export const filesListTool: ToolDefinition<typeof filesListSchema> = {
  name: 'files.list',
  description: 'List files by querying the files metadata table. Optionally filter by name prefix.',
  inputSchema: filesListSchema,
  execute: async ({ prefix }, _context) => {
    const rows = prefix
      ? await db.select().from(files).where(like(files.path, `%${prefix}%`))
      : await db.select().from(files);

    if (rows.length === 0) return 'No files found.';
    return rows
      .map(r => `${r.id} | ${path.basename(r.path)} | ${r.mimeType} | ${r.sizeBytes}B | ${r.createdAt.toISOString()}`)
      .join('\n');
  },
  kind: 'builtin',
  capability: 'resource',
};

// ─── delete ───────────────────────────────────────────────────────────────────

const filesDeleteSchema = z.object({
  name: z.string().describe('File UUID or partial filename to match'),
});

export const filesDeleteTool: ToolDefinition<typeof filesDeleteSchema> = {
  name: 'files.delete',
  description: 'Delete a file — removes both the blob from the files volume and its metadata row.',
  inputSchema: filesDeleteSchema,
  execute: async ({ name }, _context) => {
    const isUuid = /^[0-9a-f-]{36}$/i.test(name);
    const rows = isUuid
      ? await db.select().from(files).where(eq(files.id, name))
      : await db.select().from(files).where(like(files.path, `%${name}%`));

    if (rows.length === 0) return `No file found for: ${name}`;
    const row = rows[0]!;

    try {
      await unlink(row.path);
    } catch (err) {
      log.warn('[files.delete] unlink failed', { path: row.path, error: String(err) });
    }

    await db.delete(files).where(eq(files.id, row.id));
    return `Deleted ${path.basename(row.path)} (${row.id})`;
  },
  kind: 'builtin',
  capability: 'tool',
  requiresConfirmation: true,
};

export const filesToolset: ToolsetDefinition = {
  name: 'files',
  description: 'Use when you need to upload, download, list, or delete files.',
  tools: [filesUploadTool, filesDownloadTool, filesListTool, filesDeleteTool],
};
