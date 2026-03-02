import type { ContextQuery, ContextResult, TurnContext } from '@/types';
import { toolRegistry } from '@/tools/registry';

/**
 * Provides tool_descriptions: the agent's available tools listed with descriptions.
 * Surface and standalone tools are never trimmed.
 */
export const toolsQuery: ContextQuery = {
  name: 'tool_descriptions',
  priority: 1,
  run: async (turn: Omit<TurnContext, 'assembled'>): Promise<ContextResult> => {
    const lines: string[] = [];
    for (const name of turn.agent.tools) {
      const t = toolRegistry.get(name);
      if (t) lines.push(`**${t.name}**: ${t.description}`);
    }

    if (lines.length === 0) return { content: '', tokenCount: 0, truncate: 'never' };

    const content = lines.join('\n');
    const tokenCount = Math.ceil(content.length / 4);
    return { content, tokenCount, truncate: 'never' };
  },
};
