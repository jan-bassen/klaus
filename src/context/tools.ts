import type { ContextQuery, ContextResult, TurnContext } from '../types';

/**
 * Provides tool_descriptions: standalone + surface tool descriptions
 * plus a listToolSets() index of available on-demand toolsets.
 * Surface and standalone tools are never trimmed.
 */
export const toolsQuery: ContextQuery = {
  name: 'tool_descriptions',
  priority: 1,
  run: async (_turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult> => {
    throw new Error('TODO: not implemented');
  },
};
