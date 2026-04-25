import path from "node:path";
import { settings } from "@/infra/config";
import { log } from "@/infra/logger";
import { hbs } from "@/infra/vault/markdown";
import type { Variable } from "@/primitives/variables";

const fmPattern = /^---\n[\s\S]*?\n---\n?/;

async function readSnippet(filePath: string): Promise<string> {
	try {
		const raw = await Bun.file(filePath).text();
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

/**
 * Loads snippets from `{vault}/Klaus/snippets/*.md`.
 * Each snippet is compiled against the full assembled namespace, making it a
 * true reusable template. Snippets may reference other snippets via
 * `{{snippets.<name>}}` — resolved by fixed-point iteration up to
 * `MAX_RECURSION_PASSES`. The `user.md` snippet is handled by the `user` variable.
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

		const glob = new Bun.Glob("*.md");
		for await (const file of glob.scan({ cwd: snippetsDir })) {
			const stem = path.basename(file, ".md");
			if (stem === "user") continue; // owned by user variable
			raw[stem] = await readSnippet(path.join(snippetsDir, file));
		}

		let prev: Record<string, string> = {};
		for (const [k, content] of Object.entries(raw)) {
			prev[k] = compile(content, vars);
		}
		for (let pass = 0; pass < MAX_RECURSION_PASSES; pass++) {
			const next: Record<string, string> = {};
			for (const [k, content] of Object.entries(raw)) {
				next[k] = compile(content, { ...vars, snippets: prev });
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
