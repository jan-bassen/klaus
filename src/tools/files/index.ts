import { z } from 'zod';
import type { ToolDefinition } from '../../types';

const filesUploadSchema = z.object({
  name: z.string(),
  content: z.string().describe('Base64-encoded file content'),
  mimeType: z.string(),
});

export const filesUploadTool: ToolDefinition<typeof filesUploadSchema> = {
  name: 'files.upload',
  description: 'Upload a file to the files volume.',
  inputSchema: filesUploadSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'tool',
};

const filesDownloadSchema = z.object({
  name: z.string(),
});

export const filesDownloadTool: ToolDefinition<typeof filesDownloadSchema> = {
  name: 'files.download',
  description: 'Download a file from the files volume.',
  inputSchema: filesDownloadSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'resource',
};

const filesListSchema = z.object({
  prefix: z.string().optional(),
});

export const filesListTool: ToolDefinition<typeof filesListSchema> = {
  name: 'files.list',
  description: 'List files in the files volume.',
  inputSchema: filesListSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'resource',
};

const filesDeleteSchema = z.object({
  name: z.string(),
});

export const filesDeleteTool: ToolDefinition<typeof filesDeleteSchema> = {
  name: 'files.delete',
  description: 'Delete a file from the files volume.',
  inputSchema: filesDeleteSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'tool',
  requiresConfirmation: true,
};

export const filesToolset = [filesUploadTool, filesDownloadTool, filesListTool, filesDeleteTool];
