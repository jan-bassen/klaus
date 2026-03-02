import { desc, eq } from 'drizzle-orm';
import type { ContextQuery, ContextResult, TurnContext } from '@/types';
import { config } from '@/config';
import { db } from '@/db/client';
import { messages } from '@/db/schema';

/** Provides conversation: last N messages from the messages table for this chatId. */
export const conversationQuery: ContextQuery = {
  name: 'conversation',
  priority: 3,
  run: async (turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult> => {
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.whatsappChatId, turn.msg.chatId))
      .orderBy(desc(messages.createdAt))
      .limit(100);

    const budget = config.context.conversationTokens;
    let tokenCount = 0;
    const included: typeof rows = [];

    for (const row of rows) {
      if (!row.content) continue;
      const msgTokens = row.tokensUsed ?? Math.ceil(row.content.length / 4);
      if (tokenCount + msgTokens > budget) break;
      included.push(row);
      tokenCount += msgTokens;
    }

    // Reverse to chronological order for the LLM
    included.reverse();

    const content = included
      .map((row) => `${row.role === 'user' ? 'User' : 'Klaus'}: ${row.content}`)
      .join('\n\n');

    return { content, tokenCount, truncate: 'oldest' };
  },
};
