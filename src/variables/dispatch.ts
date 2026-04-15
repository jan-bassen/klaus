import type { Variable } from "@/variables";

/**
 * Dispatch context when the agent was invoked via dispatch() (scheduled run,
 * agent-to-agent call, persistent tick). Null for direct @agent calls.
 */
export const dispatchVariable: Variable = {
	key: "dispatch",
	description: "Dispatch caller, objective, and mode",
	hidden: true,
	async run(turn) {
		const ctx = turn.dispatchContext;
		if (!ctx) return null;
		return {
			caller: ctx.caller,
			objective: ctx.objective,
			hint: ctx.hint ?? null,
			mode: ctx.mode.kind,
			hasMessage: !!turn.message,
		};
	},
};
