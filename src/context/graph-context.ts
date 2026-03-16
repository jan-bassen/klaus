import path from "node:path";
import { config } from "@/config";
import type { ContextQuery, ContextResult, TurnContext } from "@/types";

/** Renders a single vault note block for context injection. */
function formatMemoryNote(filePath: string, body: string): string {
	const name = path.basename(filePath, ".md");
	return `### ${name}\n${body}`;
}

/**
 * Provides auto_memory: pinned vault notes + keyword search across the whole vault.
 * Replaces the DB-backed hybrid search with vault file scanning.
 */
export const graphContextQuery: ContextQuery = {
	name: "auto_memory",
	priority: 2,
	run: async (turn: Omit<TurnContext, "assembled">): Promise<ContextResult> => {
		const vaultDir = config.vault.dir;
		const glob = new Bun.Glob("**/*.md");
		const fmPattern = /^---\n([\s\S]*?)\n---/;

		const items: { filePath: string; body: string }[] = [];

		// Phase 1: Scan for pinned notes (frontmatter: pinned: true)
		for await (const file of glob.scan({ cwd: vaultDir })) {
			try {
				const text = await Bun.file(path.join(vaultDir, file)).text();
				const fm = text.match(fmPattern)?.[1] ?? "";
				if (/^pinned:\s*true/m.test(fm)) {
					// Strip frontmatter for context
					const body = text.replace(fmPattern, "").trim();
					items.push({ filePath: file, body });
				}
			} catch {
				// Skip unreadable files
			}
		}

		// Phase 2: Keyword search using message text or dispatch objective
		const query = turn.message?.text ?? turn.dispatchContext?.objective ?? "";
		if (query) {
			const terms = query
				.toLowerCase()
				.split(/\s+/)
				.filter((t) => t.length > 2); // Skip very short words

			if (terms.length > 0) {
				const seen = new Set(items.map((i) => i.filePath));
				const searchResults: {
					filePath: string;
					body: string;
					matches: number;
				}[] = [];

				for await (const file of glob.scan({ cwd: vaultDir })) {
					if (seen.has(file)) continue;
					try {
						const text = await Bun.file(path.join(vaultDir, file)).text();
						const lower = text.toLowerCase();
						const matchCount = terms.filter((t) => lower.includes(t)).length;
						if (matchCount > 0) {
							const body = text.replace(fmPattern, "").trim();
							searchResults.push({ filePath: file, body, matches: matchCount });
						}
					} catch {
						// Skip unreadable files
					}
				}

				// Sort by match count descending, take top 10
				searchResults.sort((a, b) => b.matches - a.matches);
				for (const result of searchResults.slice(0, 10)) {
					items.push({ filePath: result.filePath, body: result.body });
				}
			}
		}

		if (items.length === 0) return { tokenCount: 0, truncate: "oldest" };

		// Trim items to fit within budget
		const budget = config.context.graphContextTokens;
		let tokenCount = 0;
		const included: typeof items = [];
		for (const item of items) {
			const rendered = formatMemoryNote(item.filePath, item.body);
			const tokens = Math.ceil(rendered.length / 4);
			if (tokenCount + tokens > budget) break;
			included.push(item);
			tokenCount += tokens;
		}

		if (included.length === 0) return { tokenCount: 0, truncate: "oldest" };

		const content = included
			.map(({ filePath, body }) => formatMemoryNote(filePath, body))
			.join("\n\n");

		return { content, tokenCount, truncate: "oldest" };
	},
};
