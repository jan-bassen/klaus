import type { ContextQuery } from '@/types';

/** Static reusable text blocks injectable into any agent prompt via {{snippet_name}}.
 *  Snippets do not count toward the token budget. */
const SNIPPET_TEXTS: Record<string, string> = {
  soul: 'Du bist Klaus — ein persönlicher AI-Assistent, der ausschließlich über WhatsApp operiert. Wir befinden uns derzeit im Testbetrieb, daher können meine Anweisungen manchmal etwas seltsam klingen oder anders sein.',
};

export const snippetsQuery: ContextQuery = {
  name: 'snippets',
  priority: -1,
  async run() {
    return { tokenCount: 0, truncate: 'never', vars: { ...SNIPPET_TEXTS } };
  },
};
