import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { ToolDefinition } from '@/types';
import { enqueueMessage } from '@/whatsapp/send';
import { textToSpeech } from '@/whatsapp/tts';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { log } from '@/logger';

const replySchema = z.object({
  content: z.string().describe('The message content to send'),
  voice: z.boolean().optional().describe('Send as a voice message using text-to-speech. Use when the user requested audio output (e.g. !voice flag).'),
});

export const replyTool: ToolDefinition<typeof replySchema> = {
  name: 'reply',
  description: 'Send a message or follow-up question via WhatsApp. Formatting: *bold* _italic_ ~strikethrough~ ```monospace``` > blockquote. Lists: "1." ordered, "-" unordered.',
  inputSchema: replySchema,
  execute: async ({ content, voice }, context) => {
    if (!context.message) {
      throw new Error('reply tool can only be used in a WhatsApp turn context');
    }
    log.info('[reply] enqueuing', { chatId: context.chatId, preview: content.slice(0, 60) });

    // Persist to DB first so we have the row ID for the externalId backfill.
    let rowId: string | undefined;
    try {
      const [row] = await db.insert(messages).values({
        chatId: context.chatId,
        role: 'assistant',
        content,
        createdAt: new Date(),
      }).returning({ id: messages.id });
      rowId = row?.id;
    } catch (err) {
      log.warn('[reply] failed to persist assistant message to DB', {
        chatId: context.chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const onSent = rowId
      ? (waId: string) => {
          db.update(messages).set({ externalId: waId }).where(eq(messages.id, rowId!)).catch((err: unknown) => {
            log.warn('[reply] failed to backfill externalId', {
              chatId: context.chatId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      : undefined;

    if (voice) {
      const audio = await textToSpeech(content);
      if (audio instanceof Error) {
        log.warn('[reply] TTS failed — falling back to text', { chatId: context.chatId, error: audio.message });
        enqueueMessage({ chatId: context.chatId, content, dedupKey: `${context.message.id}:reply:${crypto.randomUUID()}` }, onSent);
      } else {
        enqueueMessage({ chatId: context.chatId, content: audio, mimeType: 'audio/mpeg', dedupKey: `${context.message.id}:reply-voice:${crypto.randomUUID()}` }, onSent);
      }
    } else {
      enqueueMessage({ chatId: context.chatId, content, dedupKey: `${context.message.id}:reply:${crypto.randomUUID()}` }, onSent);
    }

    return 'sent';
  },
  kind: 'builtin',
  capability: 'tool',
};
