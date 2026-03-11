import { z } from "zod";
import { log } from "@/logger";
import type { ToolDefinition, ToolsetDefinition } from "@/types";

/** Maps tool name → ToolDefinition. Populated at startup by loadAllTools(). */
export const toolRegistry = new Map<string, ToolDefinition<z.ZodTypeAny>>();

/** Maps toolset name → ToolsetDefinition. Populated at startup by loadAllTools(). */
export const toolsetRegistry = new Map<string, ToolsetDefinition>();

export function registerTool(tool: ToolDefinition<z.ZodTypeAny>): void {
	toolRegistry.set(tool.name, tool);
}

export function registerToolset(ts: ToolsetDefinition): void {
	toolsetRegistry.set(ts.name, ts);
	for (const t of ts.tools) registerTool(t);
}

/**
 * Generate a meta-tool for a toolset. The model calls this (e.g. `use_files`) to
 * opt into the toolset; `prepareStep` then injects the real tools for subsequent steps.
 */
export function generateMetaTool(
	ts: ToolsetDefinition,
): ToolDefinition<typeof emptySchema> {
	const toolList = ts.tools
		.map((t) => `• ${t.name}: ${t.description}`)
		.join("\n");
	return {
		name: `use_${ts.name}`,
		description: `Activate the ${ts.name} toolset. ${ts.description}\n\nTools you will gain access to:\n${toolList}`,
		inputSchema: emptySchema,
		execute: async (_input, _context) =>
			`✓ ${ts.name} toolset activated. Tools now available:\n${toolList}`,
		kind: "builtin",
		capability: "tool",
	};
}

const emptySchema = z.object({});

/**
 * Register all tools found in toolsDir. Call once at startup before any agent runs.
 * Scans toolsDir/*.ts for standalone tools and toolsDir/sets/*.ts for toolsets.
 * Any exported ToolsetDefinition, ToolDefinition, or ToolDefinition[] is registered automatically.
 */
export async function loadAllTools(toolsDir: string): Promise<void> {
	const standalone = new Bun.Glob("*.ts");
	for await (const file of standalone.scan({ cwd: toolsDir })) {
		await loadToolModule(`${toolsDir}/${file}`);
	}

	const toolsets = new Bun.Glob("sets/*.ts");
	for await (const file of toolsets.scan({ cwd: toolsDir })) {
		await loadToolModule(`${toolsDir}/${file}`);
	}
}

async function loadToolModule(filePath: string): Promise<void> {
	try {
		const mod = (await import(filePath)) as Record<string, unknown>;
		for (const exported of Object.values(mod)) {
			if (isToolsetDefinition(exported)) {
				registerToolset(exported);
			} else if (isToolDefinition(exported)) {
				registerTool(exported);
			} else if (
				Array.isArray(exported) &&
				exported.length > 0 &&
				isToolDefinition(exported[0])
			) {
				for (const t of exported)
					registerTool(t as ToolDefinition<z.ZodTypeAny>);
			}
		}
	} catch (err) {
		// Log errors but don't crash startup — a broken tool file shouldn't kill the process
		log.error("[tools] failed to load module", {
			filePath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

function isToolsetDefinition(x: unknown): x is ToolsetDefinition {
	return (
		typeof x === "object" &&
		x !== null &&
		"name" in x &&
		typeof (x as Record<string, unknown>).name === "string" &&
		"tools" in x &&
		Array.isArray((x as Record<string, unknown>).tools) &&
		!("execute" in x)
	);
}

function isToolDefinition(x: unknown): x is ToolDefinition<z.ZodTypeAny> {
	return (
		typeof x === "object" &&
		x !== null &&
		"name" in x &&
		typeof (x as Record<string, unknown>).name === "string" &&
		"execute" in x &&
		typeof (x as Record<string, unknown>).execute === "function" &&
		"inputSchema" in x
	);
}

/** Returns all registered tools whose name starts with `{toolsetName}.` */
export function getToolsForToolset(
	toolsetName: string,
): ToolDefinition<z.ZodTypeAny>[] {
	const prefix = `${toolsetName}.`;
	return [...toolRegistry.values()].filter((t) => t.name.startsWith(prefix));
}
