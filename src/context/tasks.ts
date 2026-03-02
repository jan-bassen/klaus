import { inArray } from 'drizzle-orm';
import type { ContextQuery, ContextResult, TurnContext } from '@/types';
import { db } from '@/db/client';
import { tasks } from '@/db/schema';

/** Provides active_tasks: all non-terminal tasks from the tasks table. */
export const activeTasksQuery: ContextQuery = {
  name: 'active_tasks',
  priority: 4,
  run: async (_turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult> => {
    const rows = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ['pending', 'running']));

    if (rows.length === 0) return { content: '', tokenCount: 0, truncate: 'always' };

    const content = rows.map((t) => `- [${t.status}] ${t.objective}`).join('\n');
    const tokenCount = Math.ceil(content.length / 4);
    return { content, tokenCount, truncate: 'always' };
  },
};
