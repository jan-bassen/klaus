import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { ToolDefinition, ToolsetDefinition } from '@/types';
import { hybridSearch } from '@/db/search';
import { writeNode } from '@/db/write';
import { db } from '@/db/client';
import { edges, nodes } from '@/db/schema';

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
  execute: async (input) => {
    const results = await hybridSearch({ query: input.query, ...(input.tags ? { tags: input.tags } : {}), limit: input.limit });
    if (results.length === 0) return 'No results found.';
    return results
      .map(({ node, matchingChunk }) => {
        const body = matchingChunk ?? node.body ?? '';
        return `[${node.id}] ${node.title ?? '(untitled)'} (${node.type})\n${body}`;
      })
      .join('\n\n');
  },
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
  execute: async (input) => {
    const node = await writeNode({
      type: input.type,
      title: input.title ?? null,
      body: input.body ?? null,
      tags: input.tags ?? [],
    });
    return `Created node ${node.id}`;
  },
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
  execute: async (input) => {
    const [node] = await db.select().from(nodes).where(eq(nodes.id, input.id));
    if (!node) return `Node ${input.id} not found.`;
    return `[${node.id}] ${node.title ?? '(untitled)'} (${node.type})\n${node.body ?? ''}`;
  },
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
  execute: async (input) => {
    await db.update(nodes).set({ archived: true }).where(eq(nodes.id, input.id));
    return `Archived node ${input.id}`;
  },
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
  execute: async (input) => {
    await db.insert(edges)
      .values({ sourceId: input.sourceId, targetId: input.targetId, relation: input.relation, ...(input.note ? { note: input.note } : {}) })
      .onConflictDoNothing();
    return `Linked ${input.sourceId} → ${input.targetId} (${input.relation})`;
  },
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
  execute: async (input) => {
    await db.delete(edges).where(
      and(eq(edges.sourceId, input.sourceId), eq(edges.targetId, input.targetId), eq(edges.relation, input.relation)),
    );
    return `Removed edge ${input.sourceId} → ${input.targetId} (${input.relation})`;
  },
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
  execute: async (input) => {
    const visited = new Set<string>([input.startId]);
    let frontier = [input.startId];
    const result: Array<typeof nodes.$inferSelect> = [];

    const [start] = await db.select().from(nodes).where(eq(nodes.id, input.startId));
    if (!start) return `Node ${input.startId} not found.`;
    result.push(start);

    for (let hop = 0; hop < input.depth; hop++) {
      const edgeFilter = input.relations?.length
        ? and(inArray(edges.sourceId, frontier), inArray(edges.relation, input.relations as Array<typeof edges.relation._.data>))
        : inArray(edges.sourceId, frontier);
      const edgeRows = await db.select({ targetId: edges.targetId }).from(edges).where(edgeFilter);
      const nextIds = edgeRows.map((e) => e.targetId).filter((id) => !visited.has(id));
      if (nextIds.length === 0) break;
      const nextNodes = await db.select().from(nodes).where(inArray(nodes.id, nextIds));
      for (const n of nextNodes) { visited.add(n.id); result.push(n); }
      frontier = nextIds;
    }

    return result
      .map((n) => `[${n.id}] ${n.title ?? '(untitled)'} (${n.type})\n${n.body ?? ''}`)
      .join('\n\n');
  },
  kind: 'builtin',
  capability: 'resource',
};

export const memoryToolset: ToolsetDefinition = {
  name: 'memory',
  description: 'Use when you need to search, read, write, or manage nodes and edges in the knowledge graph.',
  tools: [
    memorySearchTool,
    memoryWriteTool,
    memoryReadTool,
    memoryArchiveTool,
    memoryLinkTool,
    memoryUnlinkTool,
    memoryTraverseTool,
  ],
};
