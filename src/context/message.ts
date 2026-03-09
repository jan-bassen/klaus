import type { ContextQuery, ContextResult, TurnContext } from '@/types';

/**
 * Exposes current-message metadata as template variables so agent .md files
 * can control how message type, transcripts, attachments, and quoted replies
 * are presented using {{#is_voice}}, {{quoted_text}}, etc.
 *
 * All values are delivered as vars (token-free) since they're small.
 */
export const messageQuery: ContextQuery = {
  name: 'message',
  priority: -1,
  run: async (turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult> => {
    const msg = turn.message;
    if (!msg) return { tokenCount: 0, truncate: 'never' };

    const media = msg.media;
    const isVoice = !!media && media.mimeType.startsWith('audio/');
    const isImage = !!media && media.mimeType.startsWith('image/');
    const isDocument = !!media && !isVoice && !isImage;
    const isReply = !!msg.quotedMessage;

    const type = isVoice ? 'voice' : isImage ? 'image' : isDocument ? 'document' : 'text';

    return {
      tokenCount: 0,
      truncate: 'never',
      vars: {
        message_type: type,
        is_reply: isReply,
        transcript: media?.transcription ?? '',
        voice_caption: media?.voiceCaption ?? '',
        attachment_name: media?.fileName ?? '',
        attachment_mime: isDocument ? (media?.mimeType ?? '') : '',
        quoted_text: msg.quotedMessage?.text ?? '',
      },
    };
  },
};
