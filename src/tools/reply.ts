import { z } from 'zod';
import type { ToolDefinition } from '../types';

const replySchema = z.object({
  content: z.string().describe('The message content to send'),
  reaction: z.string().optional().describe('Optional emoji reaction to send'),
});

export const replyTool: ToolDefinition<typeof replySchema> = {
  name: 'reply',
  description: 'Send a message, media, reaction, or follow-up question via WhatsApp.',
  inputSchema: replySchema,
  execute: async (_input, _context) => {
    throw new Error('TODO: not implemented');
  },
  kind: 'builtin',
  capability: 'tool',
};
