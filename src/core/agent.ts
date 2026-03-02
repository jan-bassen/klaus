import { parse as parseYaml } from 'yaml';
import type { AgentDefinition, AgentHookConfig, TurnContext, AgentReturn, AssembledContext } from '@/types';
import type { ModelTier } from '@/config';
import { config } from '@/config';
import { toolRegistry } from '@/tools/registry';
import { callModel } from './model-router';

function buildSystemPrompt(body: string, assembled: AssembledContext): string {
  const sections: string[] = [body.trim()];

  if (assembled.toolDescriptions) {
    sections.push(`## Available Tools\n${assembled.toolDescriptions}`);
  }
  if (assembled.conversation) {
    sections.push(`## Conversation History\n${assembled.conversation}`);
  }
  if (assembled.graphContext) {
    sections.push(`## Knowledge Graph\n${assembled.graphContext}`);
  }
  if (assembled.activeTasks) {
    sections.push(`## Active Tasks\n${assembled.activeTasks}`);
  }
  if (assembled.flagInjections) {
    sections.push(assembled.flagInjections);
  }

  return sections.join('\n\n');
}

/**
 * Generic agent execution engine used by all agents.
 * Loads the agent's prompt, runs the agentic loop via the Vercel AI SDK,
 * and returns the structured output (if the agent has hooks) or void.
 */
export async function runAgent(
  turn: TurnContext,
  def: AgentDefinition,
): Promise<AgentReturn | void> {
  // Load prompt body (strip YAML frontmatter)
  const raw = await Bun.file(def.promptPath).text();
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');

  const system = buildSystemPrompt(body, turn.assembled);

  // Build Vercel AI SDK tools — closures over turn so execute receives TurnContext
  const tools: Record<string, { description: string; parameters: unknown; execute: (input: unknown) => Promise<unknown> }> = {};
  for (const name of def.tools) {
    const t = toolRegistry.get(name);
    if (t) {
      tools[name] = {
        description: t.description,
        parameters: t.inputSchema,
        execute: (input: unknown) => t.execute(input as never, turn),
      };
    }
  }

  const result = await callModel({
    tier: def.modelTier,
    ...(turn.msg.kind !== 'async' ? { chatId: turn.msg.chatId } : {}),
    system,
    messages: [
      {
        role: 'user',
        content:
          turn.msg.kind === 'async'
            ? typeof turn.msg.input === 'string'
              ? turn.msg.input
              : JSON.stringify(turn.msg.input)
            : turn.msg.text ?? '',
      },
    ],
    ...(Object.keys(tools).length > 0 ? { tools: tools as never } : {}),
  });

  // Structured agents (e.g. memorize-agent) return JSON matching AgentReturn in their text
  try {
    return JSON.parse(result.content) as AgentReturn;
  } catch {
    return undefined;
  }
}

/**
 * Load an AgentDefinition from its .md file (parses YAML frontmatter).
 * Called at startup and on hot-reload.
 */
export async function loadAgentDefinition(promptPath: string): Promise<AgentDefinition> {
  const raw = await Bun.file(promptPath).text();

  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`No YAML frontmatter found in: ${promptPath}`);

  const front = parseYaml(match[1]!) as Record<string, unknown>;

  const name = front.name;
  if (typeof name !== 'string' || !name) {
    throw new Error(`Missing or invalid 'name' in: ${promptPath}`);
  }

  const modelTier = front.modelTier;
  const validTiers = Object.keys(config.models) as ModelTier[];
  if (typeof modelTier !== 'string' || !validTiers.includes(modelTier as ModelTier)) {
    throw new Error(`Invalid 'modelTier' "${String(modelTier)}" in: ${promptPath}`);
  }

  const tools: string[] = Array.isArray(front.tools)
    ? (front.tools as string[])
    : [];

  // Normalize hooks: [] → undefined, { runAfter: [...] } → AgentHookConfig[]
  let hooks: AgentHookConfig[] | undefined;
  const rawHooks = front.hooks;
  if (Array.isArray(rawHooks) && rawHooks.length > 0) {
    hooks = rawHooks as AgentHookConfig[];
  } else if (rawHooks && typeof rawHooks === 'object' && !Array.isArray(rawHooks)) {
    const runAfter = (rawHooks as Record<string, unknown>).runAfter;
    if (Array.isArray(runAfter) && runAfter.length > 0) {
      hooks = runAfter as AgentHookConfig[];
    }
  }

  return {
    name,
    modelTier: modelTier as ModelTier,
    tools,
    ...(hooks ? { hooks } : {}),
    promptPath,
  };
}

/**
 * Registry of all loaded agents. Populated at startup by scanning /src/agents/*.md.
 */
export const agentRegistry = new Map<string, AgentDefinition>();

/**
 * Scan a directory for *.md agent definition files and load them into agentRegistry.
 * Call once at startup from index.ts.
 */
export async function loadAgents(agentsDir: string): Promise<void> {
  const glob = new Bun.Glob('*.md');
  for await (const file of glob.scan({ cwd: agentsDir })) {
    const def = await loadAgentDefinition(`${agentsDir}/${file}`);
    agentRegistry.set(def.name, def);
  }
}
