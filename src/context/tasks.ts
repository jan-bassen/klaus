import type { ContextQuery, ContextResult, TurnContext } from '../types';

/** Provides active_tasks: all non-terminal tasks from the tasks table. */
export const activeTasksQuery: ContextQuery = {
  name: 'active_tasks',
  priority: 4,
  run: async (_turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult> => {
    throw new Error('TODO: not implemented');
  },
};
