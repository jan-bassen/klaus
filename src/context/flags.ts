import { flagRegistry } from "@/flags";
import type { ContextQuery, ContextResult, TurnContext } from "@/types";

export const flagsQuery: ContextQuery = {
	name: "flags",
	priority: -1,
	async run(turn: Omit<TurnContext, "assembled">): Promise<ContextResult> {
		const content = Object.keys(turn.flags)
			.filter((k) => turn.flags[k] && flagRegistry.has(k))
			.map((k) => flagRegistry.get(k)?.prompt ?? "")
			.join("\n");
		return { content, tokenCount: 0, truncate: "never" };
	},
};
