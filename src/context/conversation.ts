import { desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ContextQuery, ContextResult, TurnContext } from '@/types';
import { config } from '@/config';
import { db } from '@/db/client';
import { messages } from '@/db/schema';

// Rough token estimate: 1 token ≈ 4 characters (good enough for conversation history).
const CHARS_PER_TOKEN = 4;
const MAX_QUOTED_CHARS = 500;

/** Formats a message timestamp using the configured locale and timezone. */
export function formatMessageTimestamp(date: Date): string {
  const day = date.toLocaleDateString(config.locale, {
    day: '2-digit', month: '2-digit', timeZone: config.timezone,
  });
  const time = date.toLocaleTimeString(config.locale, {
    hour: '2-digit', minute: '2-digit', timeZone: config.timezone,
  });
  return `${day} ${time}`;
}

/** Provides conversation: last N messages from the messages table for this chatId. */
export const conversationQuery: ContextQuery = {
  name: 'conversation',
  priority: 3,
  run: async (turn: Omit<TurnContext, 'assembled'>, params?: Record<string, unknown>): Promise<ContextResult> => {
    // Skip for dispatched agents — no WhatsApp conversation context.
    if (!turn.message) {
      return { content: '', tokenCount: 0, truncate: 'oldest' };
    }

    const limit = typeof params?.limit === 'number' ? params.limit : 100;

    const quotedMsg = alias(messages, 'quoted_msg');
    const rows = await db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
        quotedContent: quotedMsg.content,
        quotedRole: quotedMsg.role,
      })
      .from(messages)
      .leftJoin(quotedMsg, eq(messages.quotedMessageId, quotedMsg.id))
      .where(eq(messages.chatId, turn.chatId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    const budget = config.context.conversationTokens;
    let tokenCount = 0;
    const included: typeof rows = [];

    for (const row of rows) {
      if (!row.content) continue;
      const quotedLen = row.quotedContent
        ? Math.min(row.quotedContent.length, MAX_QUOTED_CHARS)
        : 0;
      const msgTokens = Math.ceil((row.content.length + quotedLen) / CHARS_PER_TOKEN);
      if (tokenCount + msgTokens > budget) break;
      included.push(row);
      tokenCount += msgTokens;
    }

    // Reverse to chronological order for the LLM
    included.reverse();

    const agentLabel = turn.agent?.name ?? 'assistant';
    const content = included
      .map((row) => {
        const role = row.role === 'user' ? 'user' : agentLabel;
        const ts = formatMessageTimestamp(row.createdAt);
        const quotedRaw = row.quotedContent?.slice(0, MAX_QUOTED_CHARS) ?? null;
        const ellipsis = row.quotedContent && row.quotedContent.length > MAX_QUOTED_CHARS ? '…' : '';
        const quoteBlock = quotedRaw
          ? `> ${row.quotedRole === 'user' ? 'user' : agentLabel}: ${quotedRaw}${ellipsis}\n`
          : '';
        return `[${role} | ${ts}]\n${quoteBlock}${row.content}`;
      })
      .join('\n\n');

    return { content, tokenCount, truncate: 'oldest' };
  },
};
