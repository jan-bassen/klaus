import type { InboundMessage } from '@/types';
import { config } from '@/config';

/**
 * Parse !flags from a message and return the active flags.
 * Only recognizes flags defined in config.flags.
 */
export function parseFlags(msg: InboundMessage): Record<string, boolean> {
  if (!msg.text) return {};

  const flags: Record<string, boolean> = {};
  for (const token of msg.text.split(/\s+/)) {
    if (token.startsWith('!') && token.length > 1) {
      const name = token.slice(1);
      if (name in config.flags) flags[name] = true;
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
      return !(token.slice(1) in config.flags);
    })
    .join(' ')
    .trim();
}
