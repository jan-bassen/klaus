import { z } from "zod";
import { getBudget } from "@/store/budgets";
import { getCostSummary } from "@/store/costs";
import type { ToolDefinition } from "@/types";

const costTrackingSchema = z.object({
	period: z.enum(["today", "this_month", "last_month"]).default("today"),
});

export const costTrackingTool: ToolDefinition<typeof costTrackingSchema> = {
	name: "cost_tracking",
	description: "Query total spend (LLM + TTS + STT) and budget status.",
	inputSchema: costTrackingSchema,
	execute: async (input, context) => {
		const summary = await getCostSummary(input.period);
		const budget = getBudget(context.chatId);

		const lines = [
			`Period: ${summary.periodLabel}`,
			`Total: $${summary.total.toFixed(4)}`,
			`  LLM: $${(summary.byService.llm ?? 0).toFixed(4)}`,
			`  TTS: $${(summary.byService.tts ?? 0).toFixed(4)}`,
			`  STT: $${(summary.byService.stt ?? 0).toFixed(4)}`,
		];
		if (budget) {
			if (budget.dailyLimitUsd)
				lines.push(`Daily limit: $${budget.dailyLimitUsd}`);
			if (budget.monthlyLimitUsd)
				lines.push(`Monthly limit: $${budget.monthlyLimitUsd}`);
		}
		return lines.join("\n");
	},
	kind: "builtin",
	capability: "resource",
};
