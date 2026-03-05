import { z } from 'zod';
import type { ToolDefinition } from '@/types';
import { enqueueMessage } from '@/whatsapp/send';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { log } from '@/logger';

const replySchema = z.object({
  content: z.string().describe('The message content to send'),
});

export const replyTool: ToolDefinition<typeof replySchema> = {
  name: 'reply',
  description: 'Send a message or follow-up question via WhatsApp. Formatting: *bold* _italic_ ~strikethrough~ ```monospace``` > blockquote. Lists: "1." ordered, "-" unordered.',
  inputSchema: replySchema,
  execute: async ({ content }, context) => {
    if (!context.message) {
      throw new Error('reply tool can only be used in a WhatsApp turn context');
    }
    log.info('[reply] enqueuing', { chatId: context.chatId, preview: content.slice(0, 60) });
    enqueueMessage({
      chatId: context.chatId,
      content,
      dedupKey: `${context.message.id}:reply:${crypto.randomUUID()}`,
    });
    try {
      await db.insert(messages).values({
        chatId: context.chatId,
        role: 'assistant',
        content,
        createdAt: new Date(),
      });
    } catch (err) {
      // Message was already enqueued for delivery — report but don't fail the tool.
      log.warn('[reply] failed to persist assistant message to DB', {
        chatId: context.chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return 'sent';
  },
  kind: 'builtin',
  capability: 'tool',
};
