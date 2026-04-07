import path from "node:path";
import { parse as parseYaml } from "yaml";
import { settings } from "@/settings";
import type { ContextVariable } from "@/types";

const fmPattern = /^---\n([\s\S]*?)\n---\n?/;

type SnippetScope = "system" | "user" | "both";

interface SnippetMeta {
	scope: SnippetScope;
	content: string;
}

const VALID_SCOPES = new Set<string>(["system", "user", "both"]);

/** Parse a .md file, extract optional scope from frontmatter, return body. */
function parseMd(raw: string): SnippetMeta {
	const match = raw.match(fmPattern);
	if (!match) return { scope: "system", content: raw.trim() };

	let scope: SnippetScope = "system";
	try {
		const front = parseYaml(match[1] ?? "");
		if (front && typeof front === "object" && "scope" in front) {
			const s = (front as Record<string, unknown>).scope;
			if (typeof s === "string" && VALID_SCOPES.has(s)) {
				scope = s as SnippetScope;
			}
		}
	} catch {
		// Invalid YAML — ignore frontmatter, use defaults
	}

	const content = raw.replace(fmPattern, "").trim();
	return { scope, content };
}

/** Read and parse a .md snippet file. Returns default scope on failure. */
async function readSnippet(filePath: string): Promise<SnippetMeta> {
	try {
		const raw = await Bun.file(filePath).text();
		return parseMd(raw);
	} catch {
		return { scope: "system", content: "" };
	}
}

/**
 * Loads snippets from {vault}/Klaus/snippets/*.md, plus user.md.
 * Splits into system vars and user vars based on frontmatter scope.
 * Always included, never trimmed.
 */
export const snippetsQuery: ContextVariable = {
	name: "snippets",
	priority: -1,
	async run(_turn, _params) {
		const klausDir = settings.vault.internalPath;
		const snippetsDir = settings.vault.snippetsDir;

		const vars: Record<string, string> = {};
		const userVars: Record<string, string> = {};

		// Read all .md files in snippets/
		const glob = new Bun.Glob("*.md");
		for await (const file of glob.scan({ cwd: snippetsDir })) {
			const stem = path.basename(file, ".md");
			const snippet = await readSnippet(path.join(snippetsDir, file));

			if (snippet.scope === "system" || snippet.scope === "both") {
				vars[stem] = snippet.content;
			}
			if (snippet.scope === "user" || snippet.scope === "both") {
				userVars[stem] = snippet.content;
			}
		}

		// Read user.md from Klaus/ (always system scope)
		const userSnippet = await readSnippet(path.join(klausDir, "user.md"));
		vars.user = userSnippet.content;

		return {
			tokenCount: 0,
			truncate: "never",
			vars,
			...(Object.keys(userVars).length > 0 ? { userVars } : {}),
		};
	},
};
