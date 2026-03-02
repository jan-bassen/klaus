import type { ToolDefinition } from '@/types';

/** Maps tool name → ToolDefinition. Populated at startup by loadAllTools(). */
export const toolRegistry = new Map<string, ToolDefinition<any>>();

export function registerTool(tool: ToolDefinition<any>): void {
  toolRegistry.set(tool.name, tool);
}

/**
 * Register all built-in tools. Call once at startup before any agent runs.
 * Import order is the registration order; duplicates overwrite silently.
 */
export async function loadAllTools(): Promise<void> {
  const { replyTool } = await import('./reply');
  registerTool(replyTool);

  const { filesToolset } = await import('./files/index');
  for (const t of filesToolset) registerTool(t);
}
