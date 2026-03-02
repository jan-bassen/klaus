import { z } from 'zod';
import type { ToolDefinition } from '@/types';

// memory.search — surface tool (always available)
const memorySearchSchema = z.object({
  query: z.string().describe('Natural language query to search the knowledge graph'),
  tags: z.array(z.string()).optional().describe('Filter results by tags'),
  limit: z.number().optional().default(10),
});

export const memorySearchTool: ToolDefinition<typeof memorySearchSchema> = {
  name: 'memory.search',
  description: 'Search the knowledge graph using hybrid semantic + full-text search.',
  inputSchema: memorySearchSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'resource',
  surface: true,
};

// memory.write
const memoryWriteSchema = z.object({
  type: z.enum(['episode', 'procedure', 'topic', 'document', 'project', 'entity', 'assertion']),
  title: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const memoryWriteTool: ToolDefinition<typeof memoryWriteSchema> = {
  name: 'memory.write',
  description: 'Write a new node to the knowledge graph.',
  inputSchema: memoryWriteSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'tool',
};

// memory.read
const memoryReadSchema = z.object({
  id: z.string().uuid().describe('Node ID to read'),
});

export const memoryReadTool: ToolDefinition<typeof memoryReadSchema> = {
  name: 'memory.read',
  description: 'Read a node from the knowledge graph by ID.',
  inputSchema: memoryReadSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'resource',
};

// memory.archive
const memoryArchiveSchema = z.object({
  id: z.string().uuid(),
});

export const memoryArchiveTool: ToolDefinition<typeof memoryArchiveSchema> = {
  name: 'memory.archive',
  description: 'Archive a node (soft-delete — excluded from search by default).',
  inputSchema: memoryArchiveSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'tool',
};

// memory.link
const memoryLinkSchema = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  relation: z.enum(['about', 'part_of', 'derived_from', 'influenced_by', 'references', 'supersedes', 'related_to']),
  note: z.string().optional(),
});

export const memoryLinkTool: ToolDefinition<typeof memoryLinkSchema> = {
  name: 'memory.link',
  description: 'Create a typed edge between two nodes.',
  inputSchema: memoryLinkSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'tool',
};

// memory.unlink
const memoryUnlinkSchema = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  relation: z.enum(['about', 'part_of', 'derived_from', 'influenced_by', 'references', 'supersedes', 'related_to']),
});

export const memoryUnlinkTool: ToolDefinition<typeof memoryUnlinkSchema> = {
  name: 'memory.unlink',
  description: 'Remove an edge between two nodes.',
  inputSchema: memoryUnlinkSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'tool',
};

// memory.traverse
const memoryTraverseSchema = z.object({
  startId: z.string().uuid(),
  depth: z.number().min(1).max(3).default(1),
  relations: z.array(z.string()).optional(),
});

export const memoryTraverseTool: ToolDefinition<typeof memoryTraverseSchema> = {
  name: 'memory.traverse',
  description: 'Traverse the knowledge graph from a starting node.',
  inputSchema: memoryTraverseSchema,
  execute: async (_input, _context) => { throw new Error('TODO: not implemented'); },
  kind: 'builtin',
  capability: 'resource',
};

export const memoryToolset = [
  memorySearchTool,
  memoryWriteTool,
  memoryReadTool,
  memoryArchiveTool,
  memoryLinkTool,
  memoryUnlinkTool,
  memoryTraverseTool,
];
