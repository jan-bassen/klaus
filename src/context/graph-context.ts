import { eq } from 'drizzle-orm';
import type { ContextQuery, ContextResult, TurnContext } from '@/types';
import { hybridSearch } from '@/db/search';
import { db } from '@/db/client';
import { nodes } from '@/db/schema';

/**
 * Provides graph_context: pinned nodes (always included) + hybrid search results
 * resolved to parent nodes + 1-hop edge expansion.
 */
export const graphContextQuery: ContextQuery = {
  name: 'graph_context',
  priority: 2,
  run: async (turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult> => {
    // Always include pinned nodes
    const pinned = await db.select().from(nodes).where(eq(nodes.pinned, true));

    // Hybrid search on message text (skip if empty)
    const query = turn.msg.text ?? '';
    const searchResults = query
      ? await hybridSearch({ query, limit: 10, expandEdges: true })
      : [];

    // Merge: pinned first, then search hits (dedup by id)
    const seen = new Set<string>();
    const items: { title: string | null; body: string | null }[] = [];

    for (const node of pinned) {
      seen.add(node.id);
      items.push({ title: node.title, body: node.body });
    }
    for (const { node, matchingChunk } of searchResults) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        items.push({ title: node.title, body: matchingChunk ?? node.body });
      }
    }

    if (items.length === 0) return { content: '', tokenCount: 0, truncate: 'oldest' };

    const content = items
      .map(({ title, body }) => `### ${title ?? '(untitled)'}\n${body ?? ''}`)
      .join('\n\n');

    const tokenCount = Math.ceil(content.length / 4);
    return { content, tokenCount, truncate: 'oldest' };
  },
};
