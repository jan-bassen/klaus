import type { Variable } from "./index.ts";

/** Metadata for a generated frontmatter schedule, if this run came from one. */
export const scheduleVariable: Variable = {
	key: "schedule",
	description: "Current frontmatter schedule metadata",
	async run(turn) {
		return turn.schedule ?? null;
	},
};
