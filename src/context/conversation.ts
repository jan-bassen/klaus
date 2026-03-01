import type { ContextQuery, ContextResult, TurnContext } from '../types';

/** Provides conversation: last N messages from the messages table for this chatId. */
export const conversationQuery: ContextQuery = {
  name: 'conversation',
  priority: 3,
  run: async (_turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult> => {
    throw new Error('TODO: not implemented');
  },
};
