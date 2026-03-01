import type { ContextQuery, ContextResult } from '../types';
import type { TurnContext } from '../types';

/**
 * Provides graph_context: pinned nodes (always included) + hybrid search results
 * resolved to parent nodes + 1-hop edge expansion.
 */
export const graphContextQuery: ContextQuery = {
  name: 'graph_context',
  priority: 2,
  run: async (_turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult> => {
    throw new Error('TODO: not implemented');
  },
};
