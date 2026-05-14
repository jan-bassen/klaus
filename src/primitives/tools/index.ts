import { z } from "zod";
import { log } from "../../infra/logger.ts";
import { scanFiles } from "../../infra/runtime.ts";
import type { TurnContext } from "../../pipeline/core.ts";
// -- Tool types (owned by this domain) --

/**
 * Blast-radius declaration. The simulation wrapper routes by this field:
 *   - `external` — touches the outside world (sends a message, posts a webhook).
 *     Under `!simulate`: never invoked; a plausible fake result is returned and
 *     the intended action is logged into the per-turn overlay.
 *   - `stateful` — mutates persistent local state (vault file, timer, schedule).
 *     Under `!simulate`: optionally calls the tool's own `simulate` handler if
 *     declared (which mutates the per-turn overlay); otherwise a generic fake
 *     "ok" result is returned and the intended write is logged.
 *   - `pure`     — read-only. Always passes through to `execute`.
 */
export type SideEffect = "external" | "stateful" | "pure";

export interface ToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
	name: string;
	description: string;
	inputSchema: TInput;
	execute(input: z.infer<TInput>, context: TurnContext): Promise<unknown>;
	/**
	 * Optional under-sim handler. When set, called instead of `execute` when
	 * the turn is in simulation mode and `sideEffect` is `"stateful"`. Use it
	 * for tools whose write-then-read consistency matters within a turn (e.g.
	 * `dispatch.agent` propagating sim into inline children).
	 */
	simulate?(input: z.infer<TInput>, context: TurnContext): Promise<unknown>;
	sideEffect: SideEffect;
	kind: "builtin" | "integration";
	capability: "tool" | "resource";
	/** Override for trace-replay truncation of this tool's stringified result. */
	maxResultChars?: number;
	/** Override for the first-arg snippet shown in the `[Used X(...)]` line. */
	maxArgSnippetChars?: number;
}

export interface ToolsetDefinition {
	/** Namespace prefix, e.g. "files". Tools are named "{name}.*". */
	name: string;
	/** One-line description of when to activate this toolset. */
	description: string;
	/** All tools belonging to this toolset. */
	tools: ToolDefinition<z.ZodTypeAny>[];
}

/** Maps tool name → ToolDefinition. Populated at startup by loadAllTools(). */
export const toolRegistry = new Map<string, ToolDefinition<z.ZodTypeAny>>();

/** Maps toolset name → ToolsetDefinition. Populated at startup by loadAllTools(). */
export const toolsetRegistry = new Map<string, ToolsetDefinition>();

const VALID_SIDE_EFFECTS = new Set<SideEffect>([
	"external",
	"stateful",
	"pure",
]);

export function registerTool(tool: ToolDefinition<z.ZodTypeAny>): void {
	if (!VALID_SIDE_EFFECTS.has(tool.sideEffect)) {
		throw new Error(
			`Tool "${tool.name}" must declare a sideEffect of "external" | "stateful" | "pure"`,
		);
	}
	toolRegistry.set(tool.name, tool);
}

export function registerToolset(ts: ToolsetDefinition): void {
	toolsetRegistry.set(ts.name, ts);
	for (const t of ts.tools) registerTool(t);
}

/**
 * Generate a meta-tool for a toolset. The model calls this (e.g. `load_files`) to
 * opt into the toolset; `prepareStep` then injects the real tools for subsequent steps.
 */
export function generateMetaTool(
	ts: ToolsetDefinition,
): ToolDefinition<typeof emptySchema> {
	const toolList = ts.tools
		.map((t) => `• ${t.name}: ${t.description}`)
		.join("\n");
	return {
		name: `load_${ts.name}`,
		description: `Load the ${ts.name} toolset to gain access to its tools on the next step. ${ts.description}`,
		inputSchema: emptySchema,
		execute: async (_input, _context) =>
			`Loaded. The ${ts.name} tools are now in your toolset for the next step — call one of them to act on the user's request:\n${toolList}`,
		sideEffect: "pure",
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
	for await (const file of scanFiles(toolsDir, "*.ts")) {
		await loadToolModule(`${toolsDir}/${file}`);
	}

	for await (const file of scanFiles(toolsDir, "sets/*.ts")) {
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
			} else if (Array.isArray(exported)) {
				for (const t of exported) {
					if (isToolDefinition(t)) registerTool(t);
				}
			}
		}
	} catch (err) {
		// Log errors but don't crash startup — a broken tool file shouldn't kill the process
		log.error(`[tools] failed to load module: ${filePath}`, {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

const ToolsetShape = z
	.object({
		name: z.string(),
		tools: z.array(z.unknown()),
	})
	.passthrough();

const ToolShape = z
	.object({
		name: z.string(),
		execute: z.function(),
		inputSchema: z.unknown(),
	})
	.passthrough();

function isToolsetDefinition(x: unknown): x is ToolsetDefinition {
	return (
		ToolsetShape.safeParse(x).success && !(x as Record<string, unknown>).execute
	);
}

function isToolDefinition(x: unknown): x is ToolDefinition<z.ZodTypeAny> {
	return ToolShape.safeParse(x).success;
}
