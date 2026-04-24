import type { Variable } from "@/primitives/variables";

/**
 * The prompt the dispatcher handed to this agent. Null when the run isn't a
 * dispatched sub (message/schedule/timer triggers supply no dispatch context).
 * Who/what dispatched lives on the separate `trigger` variable.
 */
export const dispatchVariable: Variable = {
	key: "dispatch",
	description: "Dispatch prompt",
	hidden: true,
	async run(turn) {
		const ctx = turn.dispatchContext;
		if (!ctx) return null;
		return { prompt: ctx.prompt, hasMessage: !!turn.message };
	},
};
