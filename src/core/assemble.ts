import { z } from "zod";
import { config } from "@/config";
import { log } from "@/logger";
import type {
	AssembledContext,
	ContextQuery,
	ContextResult,
	TurnContext,
} from "@/types";

// Module-level registry populated at startup via setContextQueries().
// assembleContext() uses this as its default query set.
let loadedQueries: ContextQuery[] = [];

export function setContextQueries(queries: ContextQuery[]): void {
	loadedQueries = queries;
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
	queries: ContextQuery[] = loadedQueries,
): Promise<AssembledContext> {
	const settled = await Promise.allSettled(
		queries.map((q) => {
			return q.run(turn).then((result) => ({ query: q, result }));
		}),
	);

	// Collect successful results; log and skip failed queries
	const items: { query: ContextQuery; result: ContextResult }[] = [];
	for (const outcome of settled) {
		if (outcome.status === "fulfilled") {
			items.push(outcome.value);
		} else {
			log.error("[assemble] context query failed", {
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

	const excess = totalTokens - config.context.totalTokens;
	if (excess > 0) {
		let remaining = excess;
		// Lower priority number = trimmed first (per ContextQuery type comment)
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

	const vars: Record<string, unknown> = {};

	for (const { query, result } of items) {
		if (result.content !== undefined) vars[query.name] = result.content;
		if (result.vars) Object.assign(vars, result.vars);
	}

	return {
		vars,
		messageRefs: {},
		totalTokens: Math.max(0, totalTokens),
	};
}

/**
 * Scans a directory for .ts files and collects every exported value that looks
 * like a ContextQuery (has name, priority, run). Called once at startup.
 */
export async function loadContextQueries(
	contextDir: string,
): Promise<ContextQuery[]> {
	const queries: ContextQuery[] = [];
	const glob = new Bun.Glob("*.ts");
	for await (const file of glob.scan({ cwd: contextDir })) {
		try {
			const mod = (await import(`${contextDir}/${file}`)) as Record<
				string,
				unknown
			>;
			for (const exported of Object.values(mod)) {
				if (isContextQuery(exported)) {
					queries.push(exported);
					log.debug("[assemble] loaded context query", {
						name: exported.name,
						file,
					});
				}
			}
		} catch (err) {
			log.error("[assemble] failed to load context file", {
				file,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return queries;
}

const ContextQueryShape = z
	.object({
		name: z.string(),
		priority: z.number(),
		run: z.function(),
	})
	.passthrough();

function isContextQuery(x: unknown): x is ContextQuery {
	return ContextQueryShape.safeParse(x).success;
}
