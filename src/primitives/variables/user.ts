import path from "node:path";
import { settings } from "../../infra/config.ts";
import { readText } from "../../infra/runtime.ts";
import type { Variable } from "./index.ts";
/** User profile loaded from {vault}/Klaus/snippets/user.md (or user.md at vault internal root). */
export const userVariable: Variable = {
	key: "user",
	description: "User profile",
	async run() {
		// Preferred location: snippets/user.md (co-located with other snippets).
		// Fallback: {internal}/user.md (historical path).
		const candidates = [
			path.join(settings.vault.snippetsDir, "user.md"),
			path.join(settings.vault.internalPath, "user.md"),
		];
		for (const p of candidates) {
			try {
				const raw = await readText(p);
				const profile = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
				if (profile) return { profile };
			} catch {
				// try next
			}
		}
		return { profile: "" };
	},
};
