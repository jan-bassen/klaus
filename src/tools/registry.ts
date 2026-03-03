import type { ToolDefinition } from '@/types';
import { log } from '@/logger';

/** Maps tool name → ToolDefinition. Populated at startup by loadAllTools(). */
export const toolRegistry = new Map<string, ToolDefinition<any>>();

export function registerTool(tool: ToolDefinition<any>): void {
  toolRegistry.set(tool.name, tool);
}

/**
 * Register all tools found in toolsDir. Call once at startup before any agent runs.
 * Scans top-level .ts files (single tools) and subdirectory index.ts files (toolsets).
 * Any exported ToolDefinition or ToolDefinition[] is registered automatically.
 */
export async function loadAllTools(toolsDir: string): Promise<void> {
  const topLevel = new Bun.Glob('*.ts');
  for await (const file of topLevel.scan({ cwd: toolsDir })) {
    if (file === 'registry.ts') continue;
    await loadToolModule(`${toolsDir}/${file}`);
  }

  const toolsets = new Bun.Glob('*/index.ts');
  for await (const file of toolsets.scan({ cwd: toolsDir })) {
    await loadToolModule(`${toolsDir}/${file}`);
  }
}

async function loadToolModule(filePath: string): Promise<void> {
  try {
    const mod = (await import(filePath)) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (isToolDefinition(exported)) {
        registerTool(exported);
      } else if (Array.isArray(exported) && exported.length > 0 && isToolDefinition(exported[0])) {
        for (const t of exported) registerTool(t as ToolDefinition<any>);
      }
    }
  } catch (err) {
    // Log errors but don't crash startup — a broken tool file shouldn't kill the process
    log.error('[tools] failed to load module', { filePath, error: err instanceof Error ? err.message : String(err) });
  }
}

function isToolDefinition(x: unknown): x is ToolDefinition<any> {
  return (
    typeof x === 'object' && x !== null &&
    'name' in x && typeof (x as Record<string, unknown>).name === 'string' &&
    'execute' in x && typeof (x as Record<string, unknown>).execute === 'function' &&
    'inputSchema' in x
  );
}

/** Returns all registered tools whose name starts with `{toolsetName}.` */
export function getToolsForToolset(toolsetName: string): ToolDefinition<any>[] {
  const prefix = `${toolsetName}.`;
  return [...toolRegistry.values()].filter((t) => t.name.startsWith(prefix));
}
