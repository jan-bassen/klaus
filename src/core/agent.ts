import type { AgentDefinition, TurnContext, AgentReturn } from '../types';

/**
 * Generic agent execution engine used by all agents.
 * Loads the agent's prompt, runs the agentic loop via the Vercel AI SDK,
 * and returns the structured output (if the agent has hooks) or void.
 */
export async function runAgent(
  _turn: TurnContext,
  _def: AgentDefinition,
): Promise<AgentReturn | void> {
  throw new Error('TODO: not implemented');
}

/**
 * Load an AgentDefinition from its .md file (parses YAML frontmatter).
 * Called at startup and on hot-reload.
 */
export async function loadAgentDefinition(_promptPath: string): Promise<AgentDefinition> {
  throw new Error('TODO: not implemented');
}

/**
 * Registry of all loaded agents. Populated at startup by scanning /src/agents/*.md.
 */
export const agentRegistry = new Map<string, AgentDefinition>();
