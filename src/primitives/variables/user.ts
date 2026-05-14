import path from "node:path";
import { settings } from "../../infra/config.ts";
import { readText } from "../../infra/runtime.ts";
import type { Variable } from "./index.ts";

/** User profile loaded from {vault}/Klaus/snippets/user.md. */
export const userVariable: Variable = {
	key: "user",
	description: "User profile",
	async run() {
		try {
			const raw = await readText(
				path.join(settings.vault.snippetsDir, "user.md"),
			);
			const profile = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
			return { profile };
		} catch {
			return { profile: "" };
		}
	},
};
