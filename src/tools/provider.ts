import { anthropic } from '@ai-sdk/anthropic';
import type { Tool } from 'ai';

/**
 * Build an Anthropic built-in provider tool by name. Tools are handled server-side
 * by Anthropic and injected directly into the Vercel AI SDK ToolSet without wrapping.
 *
 * Reference them by name in agent frontmatter:
 *   providerTools: [web_search, web_fetch, code_execution]
 *
 * Lazy construction (called per-agent-run) avoids issues when the Anthropic SDK
 * is not configured at module load time (e.g. during tests).
 */
export function buildProviderTool(name: string): Tool | undefined {
  switch (name) {
    case 'web_search': return anthropic.tools.webSearch_20250305() as unknown as Tool;
    case 'web_fetch': return anthropic.tools.webFetch_20250910() as unknown as Tool;
    case 'code_execution': return anthropic.tools.codeExecution_20260120() as unknown as Tool;
    default: return undefined;
  }
}
