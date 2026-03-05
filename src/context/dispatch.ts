import type { ContextQuery, ContextResult } from '@/types';

/**
 * Injects dispatch_context into the agent's prompt when the agent was invoked via dispatch().
 * Renders empty for direct @agent WhatsApp calls (no dispatchContext on TurnContext).
 */
export const dispatchContextQuery: ContextQuery = {
  name: 'dispatch_context',
  priority: -1, // never trimmed
  async run(turn): Promise<ContextResult> {
    if (!turn.dispatchContext) {
      return { content: '', tokenCount: 0, truncate: 'never' };
    }

    const { caller, objective, hint, mode } = turn.dispatchContext;
    const lines = [
      '## Dispatch context',
      `Caller: ${caller}`,
      `Objective: ${objective}`,
      ...(hint ? [`Hint: ${hint}`] : []),
      `Mode: ${mode.kind}`,
    ];
    const content = lines.join('\n');
    return {
      content,
      tokenCount: Math.ceil(content.length / 4),
      truncate: 'never',
    };
  },
};
