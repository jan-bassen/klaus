import type { ContextQuery, ContextResult, TurnContext } from '@/types';
import { FLAG_MAP } from '@/whatsapp/flags';

/**
 * Provides flag_injections: parsed !flags from the current message,
 * formatted as prompt injection strings. Never trimmed.
 */
export const flagsQuery: ContextQuery = {
  name: 'flag_injections',
  priority: 0,
  run: async (turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult> => {
    const injections = Object.keys(turn.flags)
      .filter((key) => turn.flags[key] && key in FLAG_MAP)
      .map((key) => FLAG_MAP[key]!.promptInjection);

    const content = injections.join('\n');
    return {
      content,
      tokenCount: content.length === 0 ? 0 : Math.ceil(content.length / 4),
      truncate: 'never',
    };
  },
};
