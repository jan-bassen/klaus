import { parse as parseYaml } from 'yaml';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import type { AgentDefinition, TurnContext } from '@/types';
import type { ModelTier } from '@/config';
import { config } from '@/config';
import { toolRegistry, getToolsForToolset } from '@/tools/registry';
import { callModel } from './model-router';
import { log } from '@/logger';

function buildSystemPrompt(body: string, vars: Map<string, string>): string {
  // {{name}} and {{name?key=val}} both resolve to vars[name]; the ?params suffix is for query config only.
  return body.trim().replace(/\{\{(\w+)(?:\?[^}]*)?\}\}/g, (_, key: string) => vars.get(key) ?? '');
}

/**
 * Scan a prompt body for {{name?key=val&key2=val2}} placeholders and return
 * a contextParams map. Values that parse as numbers become numbers; rest stay strings.
 */
function parseInlineParams(body: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  const re = /\{\{(\w+)\?([^}]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1]!;
    const qs = m[2]!;
    result[name] ??= {};
    for (const pair of qs.split('&')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const k = pair.slice(0, eq).trim();
      const raw = pair.slice(eq + 1).trim();
      const num = Number(raw);
      result[name]![k] = raw !== '' && !isNaN(num) ? num : raw;
    }
  }
  return result;
}

/**
 * Generic agent execution engine used by all agents.
 * Loads the agent's prompt, runs the agentic loop via the Vercel AI SDK.
 * All agents produce free-text output via the reply tool — no structured return.
 */
export async function runAgent(
  turn: TurnContext,
  def: AgentDefinition,
): Promise<void> {
  // Load prompt body (strip YAML frontmatter)
  const raw = await Bun.file(def.promptPath).text();
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');

  const vars = new Map<string, string>(Object.entries(turn.assembled.vars));
  const system = buildSystemPrompt(body, vars);

  // Build Vercel AI SDK tools — closures over turn so execute receives TurnContext
  const tools: ToolSet = {};
  const addTool = (t: ReturnType<typeof toolRegistry.get>) => {
    if (!t) return;
    tools[t.name.replace(/\./g, '_')] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
      execute: (input) => t.execute(input as never, turn),
    });
  };
  for (const name of def.tools) {
    addTool(toolRegistry.get(name));
  }
  for (const tsName of (def.toolsets ?? [])) {
    for (const t of getToolsForToolset(tsName)) addTool(t);
  }

  const modelId = config.models[def.modelTier];
  log.info('[agent] calling model', { agent: def.name, model: modelId, tools: Object.keys(tools) });

  try {
    const result = await callModel({
      tier: def.modelTier,
      agentName: def.name,
      chatId: turn.chatId,
      ...(turn.messageId ? { messageId: turn.messageId } : {}),
      ...(turn.taskId ? { taskId: turn.taskId } : {}),
      system,
      messages: [
        {
          role: 'user',
          content: turn.message?.text ?? turn.dispatchContext?.objective ?? '',
        },
      ],
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
    });

    log.info('[agent] model call completed', {
      agent: def.name,
      usage: result.usage,
    });
  } catch (err) {
    log.error('[agent] callModel failed', {
      agent: def.name,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }
}

/**
 * Load an AgentDefinition from its .md file (parses YAML frontmatter).
 * Called at startup and on hot-reload.
 */
export async function loadAgentDefinition(promptPath: string): Promise<AgentDefinition> {
  log.debug('[agent] loading definition', { promptPath });
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

  const toolsets: string[] = Array.isArray(front.toolsets)
    ? (front.toolsets as string[])
    : [];

  // Optional cron schedule string (e.g. "0 3 * * *")
  const schedule = typeof front.schedule === 'string' ? front.schedule : undefined;

  // Per-query params from optional `context:` YAML key.
  // Example: context: { conversation: { limit: 10 } }
  const yamlParams: Record<string, Record<string, unknown>> =
    typeof front.context === 'object' && front.context !== null && !Array.isArray(front.context)
      ? (front.context as Record<string, Record<string, unknown>>)
      : {};

  // Inline params parsed from {{name?key=val}} placeholders in the prompt body.
  // Merged on top of YAML params (inline wins per-key).
  const body = raw.slice(match[0].length);
  const inlineParams = parseInlineParams(body);
  const merged: Record<string, Record<string, unknown>> = { ...yamlParams };
  for (const [qName, params] of Object.entries(inlineParams)) {
    merged[qName] = { ...(merged[qName] ?? {}), ...params };
  }
  const contextParams = Object.keys(merged).length > 0 ? merged : undefined;

  log.info('[agent] loaded definition', { name, modelTier, tools });

  return {
    name,
    modelTier: modelTier as ModelTier,
    tools,
    ...(toolsets.length > 0 ? { toolsets } : {}),
    ...(schedule ? { schedule } : {}),
    ...(contextParams ? { contextParams } : {}),
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
