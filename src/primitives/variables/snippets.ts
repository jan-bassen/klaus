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
 * true reusable template. The `user.md` snippet is handled by the `user` variable.
 */
export const snippetsVariable: Variable = {
	key: "snippets",
	description: "Named reusable prompt fragments",
	after: true,
	async run(turn) {
		const snippetsDir = settings.vault.snippetsDir;
		const result: Record<string, string> = {};
		const vars = turn.vars ?? {};

		const glob = new Bun.Glob("*.md");
		for await (const file of glob.scan({ cwd: snippetsDir })) {
			const stem = path.basename(file, ".md");
			if (stem === "user") continue; // owned by user variable
			const content = await readSnippet(path.join(snippetsDir, file));
			result[stem] = compile(content, vars);
		}
		return result;
	},
};
