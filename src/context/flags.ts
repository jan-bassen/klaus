import type { ContextQuery, ContextResult, TurnContext } from '../types';

/**
 * Provides flag_injections: parsed !flags from the current message,
 * formatted as prompt injection strings. Never trimmed.
 */
export const flagsQuery: ContextQuery = {
  name: 'flag_injections',
  priority: 0,
  run: async (_turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult> => {
    throw new Error('TODO: not implemented');
  },
};
