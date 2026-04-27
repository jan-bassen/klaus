import { z } from "zod";
import { log } from "@/infra/logger";
import type { TurnContext } from "@/pipeline/core";

/**
 * A Variable produces one top-level entry in the unified variable namespace.
 * Its `key` is the namespace root (e.g. `media`, `tasks`, `time`) and `run()`
 * returns the subtree placed at that key.
 *
 * All variables run in parallel and are merged into a single nested object
 * passed straight into Handlebars. No char budget, no priority, no truncation —
 * templates apply char limits explicitly via the `{{trunc}}` helper.
 */
export interface Variable {
	key: string;
	description?: string;
	hidden?: boolean;
	/**
	 * If true, this variable runs in a second phase after all non-`after` variables
	 * have resolved, and receives the partial namespace via `turn.vars`. Use this
	 * only when a variable's output depends on another variable's output (snippets).
	 */
	after?: boolean;
	run(
		turn: Omit<TurnContext, "vars"> & {
			vars?: Record<string, unknown>;
		},
	): Promise<unknown>;
}

let loadedVariables: Variable[] = [];

export function setVariables(variables: Variable[]): void {
	loadedVariables = variables;
}

export function getVariables(): Variable[] {
	return loadedVariables;
}

/** Runs all variables in parallel, merges results into a nested namespace. */
export async function assembleVariables(
	turn: Omit<TurnContext, "vars">,
	variables: Variable[] = loadedVariables,
): Promise<Record<string, unknown>> {
	const first = variables.filter((v) => !v.after);
	const second = variables.filter((v) => v.after);

	const result: Record<string, unknown> = {};

	const settled = await Promise.allSettled(
		first.map(async (v) => ({ key: v.key, value: await v.run(turn) })),
	);
	for (const outcome of settled) {
		if (outcome.status === "fulfilled") {
			result[outcome.value.key] = outcome.value.value;
		} else {
			log.error("[variables] variable failed", {
				error:
					outcome.reason instanceof Error
						? outcome.reason.message
						: String(outcome.reason),
			});
		}
	}

	const enriched = { ...turn, vars: result };
	const afterSettled = await Promise.allSettled(
		second.map(async (v) => ({ key: v.key, value: await v.run(enriched) })),
	);
	for (const outcome of afterSettled) {
		if (outcome.status === "fulfilled") {
			result[outcome.value.key] = outcome.value.value;
		} else {
			log.error("[variables] after-variable failed", {
				error:
					outcome.reason instanceof Error
						? outcome.reason.message
						: String(outcome.reason),
			});
		}
	}

	return result;
}

/** Scans a directory for .ts files and collects every exported Variable. */
export async function loadVariables(dir: string): Promise<Variable[]> {
	const variables: Variable[] = [];
	const glob = new Bun.Glob("*.ts");
	for await (const file of glob.scan({ cwd: dir })) {
		try {
			const mod = (await import(`${dir}/${file}`)) as Record<string, unknown>;
			for (const exported of Object.values(mod)) {
				if (isVariable(exported)) {
					variables.push(exported);
					log.debug(`[variables] loaded: ${exported.key}`);
				}
			}
		} catch (err) {
			log.error(`[variables] failed to load: ${file}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return variables;
}

const VariableShape = z
	.object({
		key: z.string(),
		run: z.function(),
	})
	.passthrough();

function isVariable(x: unknown): x is Variable {
	return VariableShape.safeParse(x).success;
}
