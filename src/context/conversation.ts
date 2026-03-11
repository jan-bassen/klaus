import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ContextQuery, ContextResult, TurnContext } from '@/types';
import { config } from '@/config';
import { db } from '@/db/client';
import { messages, reactions } from '@/db/schema';

// Rough token estimate: 1 token ≈ 4 characters (good enough for conversation history).
const CHARS_PER_TOKEN = 4;
const MAX_QUOTED_CHARS = 500;
const MAX_MESSAGE_CHARS = 1000;

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

/** Renders the header line for a chat message: [#label | role | timestamp] */
export function formatChatHeader(label: string, role: string, timestamp: string): string {
  return `[#${label} | ${role} | ${timestamp}]`;
}

/** Renders a full chat message block (header + optional quote + body + optional reactions). */
export function formatChatMessage(opts: {
  label: string;
  role: string;
  timestamp: string;
  body: string;
  quoteBlock?: string | undefined;
  reactionStr?: string | undefined;
}): string {
  const header = formatChatHeader(opts.label, opts.role, opts.timestamp);
  return `${header}\n${opts.quoteBlock ?? ''}${opts.body}${opts.reactionStr ?? ''}`;
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
    const excludeCurrent = !!params?.excludeCurrent && !!turn.message?.id;

    const quotedMsg = alias(messages, 'quoted_msg');
    const rows = await db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
        externalId: messages.externalId,
        quotedContent: quotedMsg.content,
        quotedRole: quotedMsg.role,
      })
      .from(messages)
      .leftJoin(quotedMsg, eq(messages.quotedMessageId, quotedMsg.id))
      .where(
        excludeCurrent
          ? and(eq(messages.chatId, turn.chatId), ne(messages.externalId, turn.message!.id))
          : eq(messages.chatId, turn.chatId),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    const budget = config.context.conversationTokens;
    let tokenCount = 0;
    const included: typeof rows = [];

    for (const row of rows) {
      if (!row.content) continue;
      const contentLen = Math.min(row.content.length, MAX_MESSAGE_CHARS);
      const quotedLen = row.quotedContent
        ? Math.min(row.quotedContent.length, MAX_QUOTED_CHARS)
        : 0;
      const msgTokens = Math.ceil((contentLen + quotedLen) / CHARS_PER_TOKEN);
      if (tokenCount + msgTokens > budget) break;
      included.push(row);
      tokenCount += msgTokens;
    }

    // Reverse to chronological order for the LLM
    included.reverse();

    // Fetch reactions for included messages so the LLM can see them inline
    const externalIds = included.map(r => r.externalId).filter((id): id is string => !!id);
    const reactionRows = externalIds.length > 0
      ? await db.select({
          messageExternalId: reactions.messageExternalId,
          emoji: reactions.emoji,
          fromMe: reactions.fromMe,
        })
        .from(reactions)
        .where(and(eq(reactions.chatId, turn.chatId), inArray(reactions.messageExternalId, externalIds)))
      : [];

    const reactionMap = new Map<string, { emoji: string; fromMe: boolean }[]>();
    for (const r of reactionRows) {
      const arr = reactionMap.get(r.messageExternalId) ?? [];
      arr.push({ emoji: r.emoji, fromMe: r.fromMe });
      reactionMap.set(r.messageExternalId, arr);
    }

    const agentLabel = turn.agent?.name ?? 'assistant';
    const messageRefs: Record<string, { externalId: string; role: string }> = {};
    const content = included
      .map((row, i) => {
        const label = i + 1;
        const role = row.role === 'user' ? 'user' : agentLabel;
        if (row.externalId) {
          messageRefs[String(label)] = { externalId: row.externalId, role: row.role };
        }
        const ts = formatMessageTimestamp(row.createdAt);
        const quotedRaw = row.quotedContent?.slice(0, MAX_QUOTED_CHARS) ?? null;
        const ellipsis = row.quotedContent && row.quotedContent.length > MAX_QUOTED_CHARS ? '…' : '';
        const quoteBlock = quotedRaw
          ? `> ${row.quotedRole === 'user' ? 'user' : agentLabel}: ${quotedRaw}${ellipsis}\n`
          : '';
        const body = row.content && row.content.length > MAX_MESSAGE_CHARS
          ? row.content.slice(0, MAX_MESSAGE_CHARS) + '…'
          : row.content;
        const rxns = row.externalId ? (reactionMap.get(row.externalId) ?? []) : [];
        const reactionStr = rxns.length > 0
          ? `\n[reactions: ${rxns.map(r => r.fromMe ? `${r.emoji} (you)` : r.emoji).join('  ')}]`
          : '';
        return formatChatMessage({
          label: String(label),
          role,
          timestamp: ts,
          body: body ?? '',
          quoteBlock: quoteBlock || undefined,
          reactionStr: reactionStr || undefined,
        });
      })
      .join('\n\n');

    return { content, tokenCount, truncate: 'oldest', vars: { _messageRefs: messageRefs } };
  },
};
