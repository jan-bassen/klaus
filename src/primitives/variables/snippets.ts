import path from "node:path";
import { settings } from "../../infra/config.ts";
import { log } from "../../infra/logger.ts";
import { readText, scanFiles } from "../../infra/runtime.ts";
import { hbs } from "../../infra/vault/markdown.ts";
import type { Variable } from "./index.ts";

const fmPattern = /^---\n[\s\S]*?\n---\n?/;

async function readSnippet(filePath: string): Promise<string> {
	try {
		const raw = await readText(filePath);
		return raw.replace(fmPattern, "").trim();
	} catch {
		return "";
	}
}

/** Compile snippet content through Handlebars with the assembled namespace. */
function compile(content: string, vars: Record<string, unknown>): string {
	if (!content.includes("{{")) return content;
	try {
		const template = hbs.compile(content, { noEscape: true });
		return template(vars).trim();
	} catch (err) {
		log.warn("[snippets] HBS compilation failed, using raw content", {
			error: err instanceof Error ? err.message : String(err),
		});
		return content;
	}
}

function withoutSelfReference(
	snippets: Record<string, string>,
	key: string,
): Record<string, string> {
	const scoped = { ...snippets };
	scoped[key] = "";
	return scoped;
}

/**
 * Loads snippets from `{vault}/Klaus/snippets/*.md`.
 * Each snippet is compiled against the full assembled namespace, making it a
 * true reusable template. Snippets may reference other snippets via
 * `{{snippets.<name>}}` — resolved by fixed-point iteration up to
 * `MAX_RECURSION_PASSES`.
 */
const MAX_RECURSION_PASSES = 5;

export const snippetsVariable: Variable = {
	key: "snippets",
	description: "Named reusable prompt fragments",
	after: true,
	async run(turn) {
		const snippetsDir = settings.vault.snippetsDir;
		const vars = turn.vars ?? {};
		const raw: Record<string, string> = {};

		for await (const file of scanFiles(snippetsDir, "*.md")) {
			const stem = path.basename(file, ".md");
			raw[stem] = await readSnippet(path.join(snippetsDir, file));
		}

		let prev: Record<string, string> = {};
		for (const [k, content] of Object.entries(raw)) {
			prev[k] = compile(content, vars);
		}
		for (let pass = 0; pass < MAX_RECURSION_PASSES; pass++) {
			const next: Record<string, string> = {};
			for (const [k, content] of Object.entries(raw)) {
				next[k] = compile(content, {
					...vars,
					snippets: withoutSelfReference(prev, k),
				});
			}
			let stable = true;
			for (const k of Object.keys(raw)) {
				if (next[k] !== prev[k]) {
					stable = false;
					break;
				}
			}
			prev = next;
			if (stable) return prev;
		}
		log.warn(
			`[snippets] did not stabilise after ${MAX_RECURSION_PASSES} passes — possible cycle`,
		);
		return prev;
	},
};
