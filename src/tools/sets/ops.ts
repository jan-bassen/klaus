import { z } from "zod";
import { dispatch } from "@/core/dispatch";
import { deleteSchedule, listSchedules } from "@/core/queue";
import { getBudget } from "@/store/budgets";
import { getCostSummary } from "@/store/costs";
import type { ToolDefinition, ToolsetDefinition } from "@/types";

const opsCronSchema = z.object({
	pattern: z.string().describe("Cron expression"),
	agentName: z.string(),
	label: z.string().describe("Human-readable label for this scheduled job"),
});

export const opsCronTool: ToolDefinition<typeof opsCronSchema> = {
	name: "ops.cron",
	description: "Schedule an agent to run on a cron pattern.",
	inputSchema: opsCronSchema,
	execute: async (input, context) => {
		await dispatch({
			agent: input.agentName,
			objective: `Scheduled: ${input.label}`,
			mode: { kind: "cron", schedule: input.pattern },
			chatId: context.chatId,
			caller: context.agent.name,
		});
		return `Scheduled ${input.agentName} with pattern "${input.pattern}" (${input.label})`;
	},
	kind: "builtin",
	capability: "tool",
};

const opsCostTrackingSchema = z.object({
	period: z.enum(["today", "this_month", "last_month"]).default("today"),
});

export const opsCostTrackingTool: ToolDefinition<typeof opsCostTrackingSchema> =
	{
		name: "ops.cost-tracking",
		description: "Query total spend (LLM + TTS + STT) and budget status.",
		inputSchema: opsCostTrackingSchema,
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

const opsCronListSchema = z.object({});

export const opsCronListTool: ToolDefinition<typeof opsCronListSchema> = {
	name: "ops.cron-list",
	description: "List all active cron schedules.",
	inputSchema: opsCronListSchema,
	execute: async () => {
		const schedules = await listSchedules();
		if (schedules.length === 0) return "No active cron schedules.";
		return schedules
			.map((s) => `${s.name} | ${s.pattern} | created: ${s.createdAt}`)
			.join("\n");
	},
	kind: "builtin",
	capability: "resource",
};

const opsCronDeleteSchema = z.object({
	agentName: z
		.string()
		.describe("Name of the agent whose cron schedule should be removed"),
});

export const opsCronDeleteTool: ToolDefinition<typeof opsCronDeleteSchema> = {
	name: "ops.cron-delete",
	description:
		"Remove a cron schedule for a named agent. Use ops.cron-list to find the name first.",
	inputSchema: opsCronDeleteSchema,
	execute: async ({ agentName }) => {
		await deleteSchedule(agentName);
		return `Deleted cron schedule for "${agentName}"`;
	},
	kind: "builtin",
	capability: "tool",
	requiresConfirmation: true,
};

export const opsToolset: ToolsetDefinition = {
	name: "ops",
	description: "Use when you need to manage cron schedules or check LLM costs.",
	tools: [opsCronTool, opsCronListTool, opsCronDeleteTool, opsCostTrackingTool],
};
