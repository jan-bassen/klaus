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
    if (context.msg.kind !== 'whatsapp') {
      throw new Error('reply tool can only be used in a WhatsApp turn context');
    }
    log.info('[reply] enqueuing', { chatId: context.msg.chatId, preview: content.slice(0, 60) });
    enqueueMessage({
      chatId: context.msg.chatId,
      content,
      dedupKey: `${context.msg.id}:reply:${crypto.randomUUID()}`,
    });
    await db.insert(messages).values({
      chatId: context.msg.chatId,
      role: 'assistant',
      content,
      createdAt: new Date(),
    });
    return 'sent';
  },
  kind: 'builtin',
  capability: 'tool',
};
