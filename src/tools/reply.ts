import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { ToolDefinition } from '@/types';
import { enqueueMessage } from '@/whatsapp/send';
import { textToSpeech } from '@/whatsapp/tts';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { resolveQuotedMessageId } from '@/db/write';
import { log } from '@/logger';

const replySchema = z.object({
  content: z.string().describe('The message content to send'),
  voice: z.boolean().optional().describe('Send as a voice message using text-to-speech. Use when the user requested audio output (e.g. !voice flag).'),
  messageRef: z.string().optional().describe('Message label from conversation history (e.g. "3") or "current" to quote-reply to that message. Omit for a normal reply.'),
});

export const replyTool: ToolDefinition<typeof replySchema> = {
  name: 'reply',
  description: 'Send a message or follow-up question via WhatsApp. Formatting: *bold* (yes, only *one* asterisk) _italic_ ~strikethrough~ ```monospace``` > blockquote. Lists: "1." ordered, "-" unordered. Use messageRef to quote-reply to a specific message from the conversation history.',
  inputSchema: replySchema,
  execute: async ({ content, voice, messageRef }, context) => {
    if (!context.message) {
      throw new Error('reply tool can only be used in a WhatsApp turn context');
    }
    log.info('[reply] enqueuing', { chatId: context.chatId, preview: content.slice(0, 60) });

    // Resolve the quoted message reference if provided.
    let quoted: { externalId: string; fromMe: boolean } | undefined;
    let quotedMessageId: string | undefined;
    if (messageRef) {
      let ref: { externalId: string; role: string } | undefined;
      if (messageRef === 'current') {
        ref = { externalId: context.message.id, role: 'user' };
      } else {
        const refs = context.assembled?.vars?._messageRefs as Record<string, { externalId: string; role: string }> | undefined;
        ref = refs?.[messageRef];
      }
      if (!ref) return { error: `Unknown message reference: #${messageRef}` };
      quoted = { externalId: ref.externalId, fromMe: ref.role !== 'user' };
      // Resolve to DB UUID for the quotedMessageId FK (best-effort).
      quotedMessageId = (await resolveQuotedMessageId(context.chatId, ref.externalId)) ?? undefined;
    }

    // Persist to DB first so we have the row ID for the externalId backfill.
    let rowId: string | undefined;
    try {
      const [row] = await db.insert(messages).values({
        chatId: context.chatId,
        role: 'assistant',
        content,
        createdAt: new Date(),
        ...(quotedMessageId ? { quotedMessageId } : {}),
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

    const dedupBase = `${context.message.id}:reply:${crypto.randomUUID()}`;
    const quotedPart = quoted ? { quoted } : {};
    if (voice) {
      const audio = await textToSpeech(content);
      if (audio instanceof Error) {
        log.warn('[reply] TTS failed — falling back to text', { chatId: context.chatId, error: audio.message });
        enqueueMessage({ chatId: context.chatId, content, dedupKey: dedupBase, ...quotedPart }, onSent);
      } else {
        enqueueMessage({ chatId: context.chatId, content: audio, mimeType: 'audio/mpeg', dedupKey: `${context.message.id}:reply-voice:${crypto.randomUUID()}`, ...quotedPart }, onSent);
      }
    } else {
      enqueueMessage({ chatId: context.chatId, content, dedupKey: dedupBase, ...quotedPart }, onSent);
    }

    return 'sent';
  },
  kind: 'builtin',
  capability: 'tool',
};
