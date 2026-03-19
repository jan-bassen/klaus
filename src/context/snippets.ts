import path from "node:path";
import { settings } from "@/settings";
import type { ContextVariable } from "@/types";

const fmPattern = /^---\n[\s\S]*?\n---\n?/;

/** Reads a .md file, strips frontmatter, returns trimmed body. Empty string on failure. */
async function readMd(filePath: string): Promise<string> {
	try {
		const text = await Bun.file(filePath).text();
		return text.replace(fmPattern, "").trim();
	} catch {
		return "";
	}
}

/**
 * Loads snippets from {vault}/Klaus/snippets/*.md, plus user.md.
 * All are injected as template vars (keyed by filename stem). Always included, never trimmed.
 */
export const snippetsQuery: ContextVariable = {
	name: "snippets",
	priority: -1,
	async run() {
		const klausDir = path.join(settings.vault.dir, "Klaus");
		const snippetsDir = path.join(klausDir, "snippets");

		const vars: Record<string, string> = {};

		// Read all .md files in snippets/
		const glob = new Bun.Glob("*.md");
		for await (const file of glob.scan({ cwd: snippetsDir })) {
			const stem = path.basename(file, ".md");
			vars[stem] = await readMd(path.join(snippetsDir, file));
		}

		// Read user.md from Klaus/
		vars.user = await readMd(path.join(klausDir, "user.md"));

		return { tokenCount: 0, truncate: "never", vars };
	},
};
