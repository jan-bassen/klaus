import type { ContextQuery, ContextResult } from '@/types';

/** Renders the dispatch context block. */
function formatDispatchBlock(ctx: { caller: string; objective: string; hint?: string | null; mode: { kind: string } }): string {
  const lines = [
    '## Dispatch context',
    `Caller: ${ctx.caller}`,
    `Objective: ${ctx.objective}`,
    ...(ctx.hint ? [`Hint: ${ctx.hint}`] : []),
    `Mode: ${ctx.mode.kind}`,
  ];
  return lines.join('\n');
}

/**
 * Injects dispatch_context into the agent's prompt when the agent was invoked via dispatch().
 * Renders empty for direct @agent WhatsApp calls (no dispatchContext on TurnContext).
 */
export const dispatchContextQuery: ContextQuery = {
  name: 'dispatch_context',
  priority: -1, // never trimmed
  async run(turn): Promise<ContextResult> {
    if (!turn.dispatchContext) {
      return { tokenCount: 0, truncate: 'never' };
    }

    const content = formatDispatchBlock(turn.dispatchContext);
    return {
      content,
      tokenCount: Math.ceil(content.length / 4),
      truncate: 'never',
    };
  },
};
