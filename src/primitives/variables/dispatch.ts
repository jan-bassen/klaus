import type { Variable } from "./index.ts";

/**
 * The prompt the dispatcher handed to this agent. Null when the run isn't a
 * dispatched sub, tool-created schedule, or timer. Frontmatter schedules use
 * the separate `schedule` variable and the agent's # Message section.
 * Who/what dispatched lives on the separate `trigger` variable.
 */
export const dispatchVariable: Variable = {
	key: "dispatch",
	description: "Dispatch prompt",
	async run(turn) {
		const ctx = turn.dispatchContext;
		if (!ctx) return null;
		return { prompt: ctx.prompt, hasMessage: !!turn.message };
	},
};
