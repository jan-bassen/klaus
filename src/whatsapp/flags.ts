import type { InboundMessage } from '../types';

export interface FlagDefinition {
  name: string;
  description: string;
  promptInjection: string;
}

/** Immutable flag map — the agent cannot create or modify these. */
export const FLAG_MAP: Record<string, FlagDefinition> = {
  verbose: {
    name: 'verbose',
    description: 'Include more detail and reasoning in the response.',
    promptInjection: 'Be thorough and detailed in your response. Show your reasoning.',
  },
  concise: {
    name: 'concise',
    description: 'Keep the response short and to the point.',
    promptInjection: 'Be concise. Omit all preamble and keep the response tight.',
  },
  debug: {
    name: 'debug',
    description: 'Include debug information in the response.',
    promptInjection: 'Include diagnostic context: which tools you called, what you found, how you decided.',
  },
  raw: {
    name: 'raw',
    description: 'Return raw output without formatting or wrapping.',
    promptInjection: 'Return raw unformatted output. No markdown, no structure, just the content.',
  },
};

/**
 * Parse !flags from a message and return the active flags.
 * Modifies neither the message nor the FLAG_MAP.
 */
export function parseFlags(msg: InboundMessage): Record<string, boolean> {
  if (!msg.text) return {};

  const flags: Record<string, boolean> = {};
  for (const token of msg.text.split(/\s+/)) {
    if (token.startsWith('!') && token.length > 1) {
      const name = token.slice(1);
      if (name in FLAG_MAP) flags[name] = true;
    }
  }
  return flags;
}

/** Remove recognized !flag tokens from text and collapse whitespace. */
export function stripFlags(text: string): string {
  return text
    .split(/\s+/)
    .filter((token) => {
      if (!token.startsWith('!') || token.length <= 1) return true;
      return !(token.slice(1) in FLAG_MAP);
    })
    .join(' ')
    .trim();
}
