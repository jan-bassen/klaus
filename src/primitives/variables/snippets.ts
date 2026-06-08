import path from "node:path";
import { settings } from "../../infra/config.ts";
import { log } from "../../infra/logger.ts";
import { readText, scanFiles } from "../../infra/runtime.ts";
import { hbs, stripPromptAuthorComments } from "../../infra/vault/markdown.ts";
import type { Variable } from "./index.ts";

const fmPattern = /^---\n[\s\S]*?\n---\n?/;

async function readSnippet(filePath: string): Promise<string> {
	try {
		const raw = await readText(filePath);
		return stripPromptAuthorComments(raw.replace(fmPattern, "")).trim();
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

/**
 * Loads snippets from `{vault}/Klaus/snippets/*.md`.
 * Each snippet is compiled against the full assembled namespace, making it a
 * reusable template. Snippets do not expand other snippets; compose snippets
 * in agent prompts instead.
 */
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

		const snippets: Record<string, string> = {};
		const scopedVars = { ...vars, snippets: {} };
		for (const [key, content] of Object.entries(raw)) {
			snippets[key] = compile(content, scopedVars);
		}
		return snippets;
	},
};
