import type { ContextQuery, ContextResult, TurnContext } from '@/types';

/** Inline prompt modifiers triggered by !flag tokens in the message. */
const FLAG_TEXTS: Record<string, string> = {
  test: 'Dies ist ein Test. Ist dies in den Prompt geraten, bitte erwähnen.',
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
