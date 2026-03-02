import type {
  InboundMessage,
  AgentDefinition,
  AssembledContext,
  ContextQuery,
  ContextResult,
} from '@/types';
import { parseFlags } from '@/whatsapp/flags';
import { config } from '@/config';

type AssembledField = keyof Omit<AssembledContext, 'totalTokens'>;

const QUERY_FIELD: Record<string, AssembledField> = {
  flag_injections: 'flagInjections',
  tool_descriptions: 'toolDescriptions',
  graph_context: 'graphContext',
  conversation: 'conversation',
  active_tasks: 'activeTasks',
};

/**
 * Runs all registered context queries in parallel, enforces the total token budget,
 * and trims lowest-priority results first according to each query's truncate strategy.
 */
export async function assembleContext(
  msg: InboundMessage,
  agent: AgentDefinition,
  queries: ContextQuery[] = [],
): Promise<AssembledContext> {
  const flags = parseFlags(msg);
  const turn = { msg, agent, flags };

  const settled = await Promise.allSettled(
    queries.map((q) => q.run(turn).then((result) => ({ query: q, result }))),
  );

  // Collect successful results; failed queries are silently skipped (field stays empty)
  const items: { query: ContextQuery; result: ContextResult }[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') items.push(outcome.value);
  }

  let totalTokens = items.reduce((sum, { result }) => sum + result.tokenCount, 0);

  const excess = totalTokens - config.context.totalTokens;
  if (excess > 0) {
    let remaining = excess;
    // Lower priority number = trimmed first (per ContextQuery type comment)
    const trimmable = [...items]
      .filter(({ result }) => result.truncate !== 'never')
      .sort((a, b) => a.query.priority - b.query.priority);

    for (const item of trimmable) {
      if (remaining <= 0) break;

      if (item.result.truncate === 'always' || item.result.truncate === 'summarize') {
        remaining -= item.result.tokenCount;
        totalTokens -= item.result.tokenCount;
        item.result = { ...item.result, content: '', tokenCount: 0 };
      } else if (item.result.truncate === 'oldest') {
        // Remove double-newline-separated blocks from the front (oldest first)
        const blocks = item.result.content.split('\n\n');
        let removed = 0;
        while (blocks.length > 0 && remaining > 0) {
          const block = blocks.shift()!;
          const tokensRemoved = Math.ceil((block.length + 2) / 4);
          remaining -= tokensRemoved;
          removed += tokensRemoved;
        }
        const newContent = blocks.join('\n\n');
        const newTokenCount = Math.max(0, item.result.tokenCount - removed);
        totalTokens -= item.result.tokenCount - newTokenCount;
        item.result = { ...item.result, content: newContent, tokenCount: newTokenCount };
      }
    }
  }

  const assembled: AssembledContext = {
    conversation: '',
    graphContext: '',
    activeTasks: '',
    toolDescriptions: '',
    flagInjections: '',
    totalTokens: Math.max(0, totalTokens),
  };

  for (const { query, result } of items) {
    const field = QUERY_FIELD[query.name];
    if (field) assembled[field] = result.content;
  }

  return assembled;
}
