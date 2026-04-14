import { z } from "zod";
import { settings } from "@/config";
import { log } from "@/logger";
import type { AssembledContext, TurnContext } from "@/types";

// -- Context variable types (owned by this domain) --

export interface ContextVariable {
	name: string;
	/** Short description for /help output */
	description?: string;
	/** Named parameters this variable accepts, e.g. { limit: "max items" } */
	params?: Record<string, string>;
	/** If true, this variable is excluded from /help output */
	hidden?: boolean;
	/** Lower number = trimmed first on overflow */
	priority: number;
	run(
		turn: Omit<TurnContext, "assembled">,
		params?: Record<string, string>,
	): Promise<ContextVariableResult>;
}

export interface ContextVariableResult {
	/** Primary content for vars[query.name]. Omit for queries that only produce vars. */
	content?: string;
	tokenCount: number;
	truncate: "never" | "always" | "oldest";
	/** Named vars to inject beyond vars[query.name]. Token-free. */
	vars?: Record<string, unknown>;
	/** Vars available only in user message $var interpolation. Token-free. */
	userVars?: Record<string, unknown>;
}

// Module-level registry populated at startup via setContextVariables().
// assembleContext() uses this as its default variable set.
let loadedVariables: ContextVariable[] = [];

export function setContextVariables(variables: ContextVariable[]): void {
	loadedVariables = variables;
}

export function getContextVariables(): ContextVariable[] {
	return loadedVariables;
}

/**
 * Runs all registered context queries in parallel, enforces the total token budget,
 * and trims lowest-priority results first according to each query's truncate strategy.
 *
 * Explicit `queries` parameter is optional — defaults to queries loaded at startup.
 * Pass an explicit list in tests to avoid depending on global state.
 */
export async function assembleContext(
	turn: Omit<TurnContext, "assembled">,
	queries: ContextVariable[] = loadedVariables,
	varParams?: Record<string, Record<string, string>>,
): Promise<AssembledContext> {
	const settled = await Promise.allSettled(
		queries.map((q) => {
			const params = varParams?.[q.name];
			return q.run(turn, params).then((result) => ({ query: q, result }));
		}),
	);

	// Collect successful results; log and skip failed variables
	const items: { query: ContextVariable; result: ContextVariableResult }[] = [];
	for (const outcome of settled) {
		if (outcome.status === "fulfilled") {
			items.push(outcome.value);
		} else {
			log.error("[assemble] context variable failed", {
				error:
					outcome.reason instanceof Error
						? outcome.reason.message
						: String(outcome.reason),
			});
		}
	}

	let totalTokens = items.reduce(
		(sum, { result }) => sum + result.tokenCount,
		0,
	);

	const excess = totalTokens - settings.context.totalTokens;
	if (excess > 0) {
		let remaining = excess;
		// Lower priority number = trimmed first (per ContextVariable type comment)
		const trimmable = [...items]
			.filter(({ result }) => result.truncate !== "never")
			.sort((a, b) => a.query.priority - b.query.priority);

		for (const item of trimmable) {
			if (remaining <= 0) break;

			if (item.result.truncate === "always") {
				remaining -= item.result.tokenCount;
				totalTokens -= item.result.tokenCount;
				item.result = { ...item.result, content: "", tokenCount: 0 };
			} else if (item.result.truncate === "oldest") {
				// Remove double-newline-separated blocks from the front (oldest first)
				const blocks = (item.result.content ?? "").split("\n\n");
				let removed = 0;
				while (blocks.length > 0 && remaining > 0) {
					const block = blocks.shift();
					if (block === undefined) break;
					const tokensRemoved = Math.ceil((block.length + 2) / 4);
					remaining -= tokensRemoved;
					removed += tokensRemoved;
				}
				const newContent = blocks.join("\n\n");
				const newTokenCount = Math.max(0, item.result.tokenCount - removed);
				totalTokens -= item.result.tokenCount - newTokenCount;
				item.result = {
					...item.result,
					content: newContent,
					tokenCount: newTokenCount,
				};
			}
		}
	}

	const vars: Record<string, unknown> = { ...turn.templateVars };
	const userVars: Record<string, unknown> = {};

	for (const { query, result } of items) {
		if (result.content !== undefined) vars[query.name] = result.content;
		if (result.vars) Object.assign(vars, result.vars);
		if (result.userVars) Object.assign(userVars, result.userVars);
	}

	return {
		vars,
		userVars,
		messageRefs: {},
		totalTokens: Math.max(0, totalTokens),
	};
}

/**
 * Scans a directory for .ts files and collects every exported value that looks
 * like a ContextVariable (has name, priority, run). Called once at startup.
 */
export async function loadContextVariables(
	contextDir: string,
): Promise<ContextVariable[]> {
	const queries: ContextVariable[] = [];
	const glob = new Bun.Glob("*.ts");
	for await (const file of glob.scan({ cwd: contextDir })) {
		try {
			const mod = (await import(`${contextDir}/${file}`)) as Record<
				string,
				unknown
			>;
			for (const exported of Object.values(mod)) {
				if (isContextVariable(exported)) {
					queries.push(exported);
					log.debug(`[assemble] loaded context variable: ${exported.name}`);
				}
			}
		} catch (err) {
			log.error(`[assemble] failed to load context variable: ${file}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return queries;
}

const ContextVariableShape = z
	.object({
		name: z.string(),
		priority: z.number(),
		run: z.function(),
	})
	.passthrough();

function isContextVariable(x: unknown): x is ContextVariable {
	return ContextVariableShape.safeParse(x).success;
}
