import type { ContextQuery, ContextResult, TurnContext } from '@/types';

/** Inline prompt modifiers triggered by !flag tokens in the message. */
const FLAG_TEXTS: Record<string, string> = {
  test: 'This is a test. If this is detected in the prompt, please mention it.',
  voice: "Answer as a voice message, please and make sure the reply text is optimized for tts!",
  de: "Antworte auf Deutsch, bitte!",
  en: "Answer in English, please!",
  verbose: "Answer verbosely, please!",
  concise: "Answer concisely, please!",
  formal: "Answer formally, please!",
};

/** Returns the set of recognized flag names. Used by the message parser. */
export function getKnownFlags(): string[] {
  return Object.keys(FLAG_TEXTS);
}

export const flagsQuery: ContextQuery = {
  name: 'flags',
  priority: -1,
  async run(turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult> {
    const content = Object.keys(turn.flags)
      .filter((k) => turn.flags[k] && k in FLAG_TEXTS)
      .map((k) => FLAG_TEXTS[k]!)
      .join('\n');
    return { content, tokenCount: 0, truncate: 'never' };
  },
};
