import type {
	ContextVariable,
	ContextVariableResult,
	TurnContext,
} from "@/types";

/** Renders the dispatch context block. */
function formatDispatchBlock(
	ctx: {
		caller: string;
		objective: string;
		hint?: string | null;
		mode: { kind: string };
	},
	hasMessage: boolean,
): string {
	const lines = [
		"## Dispatch context",
		`Caller: ${ctx.caller}`,
		`Objective: ${ctx.objective}`,
		...(ctx.hint ? [`Hint: ${ctx.hint}`] : []),
		`Mode: ${ctx.mode.kind}`,
	];
	if (!hasMessage) {
		lines.push(
			"",
			"Note: This is a scheduled invocation — there is no inbound message.",
			"Tools like `react` that require a message context will not work. Use `reply` or `send` to communicate.",
		);
	}
	return lines.join("\n");
}

/**
 * Injects dispatch_context into the agent's prompt when the agent was invoked via dispatch().
 * Renders empty for direct @agent WhatsApp calls (no dispatchContext on TurnContext).
 */
export const dispatchContextQuery: ContextVariable = {
	name: "dispatch_context",
	priority: -1, // never trimmed
	async run(
		turn: Omit<TurnContext, "assembled">,
		_params?: Record<string, string>,
	): Promise<ContextVariableResult> {
		if (!turn.dispatchContext) {
			return { tokenCount: 0, truncate: "never" };
		}

		const content = formatDispatchBlock(turn.dispatchContext, !!turn.message);
		return {
			content,
			tokenCount: Math.ceil(content.length / 4),
			truncate: "never",
		};
	},
};
