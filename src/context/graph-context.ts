import { eq } from 'drizzle-orm';
import type { ContextQuery, ContextResult, TurnContext } from '@/types';
import { config } from '@/config';
import { hybridSearch } from '@/db/search';
import { db } from '@/db/client';
import { nodes } from '@/db/schema';

/** Renders a single memory node block. */
function formatMemoryNode(title: string | null, body: string | null): string {
  return `### ${title ?? '(untitled)'}\n${body ?? ''}`;
}

/**
 * Provides auto_memory: pinned nodes (always included) + hybrid search results
 * resolved to parent nodes + 1-hop edge expansion.
 */
export const graphContextQuery: ContextQuery = {
  name: 'auto_memory',
  priority: 2,
  run: async (turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult> => {
    // Always include pinned nodes
    const pinned = await db.select().from(nodes).where(eq(nodes.pinned, true));

    // Hybrid search: use message text for WhatsApp turns, objective for dispatched agents
    const query = turn.message?.text ?? turn.dispatchContext?.objective ?? '';
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

    if (items.length === 0) return { tokenCount: 0, truncate: 'oldest' };

    // Trim items from the tail until within the per-source budget.
    const budget = config.context.graphContextTokens;
    let tokenCount = 0;
    const included: typeof items = [];
    for (const item of items) {
      const rendered = formatMemoryNode(item.title, item.body);
      const tokens = Math.ceil(rendered.length / 4);
      if (tokenCount + tokens > budget) break;
      included.push(item);
      tokenCount += tokens;
    }

    if (included.length === 0) return { tokenCount: 0, truncate: 'oldest' };

    const content = included
      .map(({ title, body }) => formatMemoryNode(title, body))
      .join('\n\n');

    return { content, tokenCount, truncate: 'oldest' };
  },
};
