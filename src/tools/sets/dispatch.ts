import { z } from "zod";
import { agentRegistry } from "@/core/agent";
import { dispatch as dispatchAgent } from "@/core/dispatch";
import { addSchedule, getSchedules, removeSchedule } from "@/store/schedules";
import { addTimer, listTimers, removeTimer } from "@/store/timers";
import type { ToolDefinition, ToolsetDefinition } from "@/types";

// -- dispatch.agent --

const dispatchAgentSchema = z.object({
	agent: z
		.string()
		.describe(
			"Name of the agent to invoke. See tool description for available agents.",
		),
	objective: z.string().describe("What the agent should accomplish"),
	hint: z
		.string()
		.optional()
		.describe("Optional additional context or instructions for the agent"),
	mode: z
		.enum(["async", "inline"])
		.default("async")
		.describe(
			"async: fire-and-forget background job; inline: run now and return result",
		),
});

const dispatchAgentTool: ToolDefinition<typeof dispatchAgentSchema> = {
	name: "dispatch.agent",
	get description(): string {
		const names = [...agentRegistry.keys()];
		const list =
			names.length > 0 ? ` Available agents: ${names.join(", ")}.` : "";
		return `Invoke another agent with an objective.${list} Use async for background work, inline to await the result.`;
	},
	inputSchema: dispatchAgentSchema,
	execute: async (input, context) => {
		const result = await dispatchAgent({
			agent: input.agent,
			objective: input.objective,
			...(input.hint ? { hint: input.hint } : {}),
			mode: input.mode === "inline" ? { kind: "inline" } : { kind: "async" },
			chatId: context.chatId,
			caller: context.agent.name,
		});
		if (input.mode === "async") {
			return `Dispatched ${input.agent} async`;
		}
		return result ?? "done";
	},
	kind: "builtin",
	capability: "tool",
};

// -- dispatch.schedule --

const dispatchScheduleSchema = z.object({
	agent: z.string().describe("Name of the agent to schedule"),
	pattern: z.string().describe("Cron expression (e.g. '0 8 * * 1-5')"),
	objective: z
		.string()
		.describe("What the agent should accomplish on each run"),
	hint: z
		.string()
		.optional()
		.describe("Optional instructions forwarded to the agent on each fire"),
	label: z.string().describe("Human-readable label for this schedule"),
});

const dispatchScheduleTool: ToolDefinition<typeof dispatchScheduleSchema> = {
	name: "dispatch.schedule",
	description:
		"Schedule an agent to run on a recurring cron pattern. Use dispatch.list to see active schedules.",
	inputSchema: dispatchScheduleSchema,
	execute: async (input, context) => {
		const id = crypto.randomUUID();
		await addSchedule({
			id,
			agentName: input.agent,
			pattern: input.pattern,
			chatId: context.chatId,
			objective: input.objective,
			...(input.hint ? { hint: input.hint } : {}),
			label: input.label,
			createdBy: context.agent.name,
			createdAt: new Date().toISOString(),
		});
		return `Scheduled ${input.agent} with pattern "${input.pattern}" (${input.label}) [${id}]`;
	},
	kind: "builtin",
	capability: "tool",
};

// -- dispatch.timer --

const DELAY_RE = /^(\d+)(s|m|h|d)$/;
const DELAY_MULTIPLIERS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

function parseRunAt(runAt: string): string {
	const match = runAt.match(DELAY_RE);
	if (match) {
		const value = Number(match[1]);
		const unit = match[2] as string;
		const ms = value * (DELAY_MULTIPLIERS[unit] ?? 0);
		return new Date(Date.now() + ms).toISOString();
	}
	// Assume ISO datetime
	const date = new Date(runAt);
	if (Number.isNaN(date.getTime())) {
		throw new Error(
			`Invalid runAt value: "${runAt}". Use ISO datetime or delay string (e.g. "2h", "30m").`,
		);
	}
	return date.toISOString();
}

const dispatchTimerSchema = z.object({
	agent: z
		.string()
		.describe("Name of the agent to invoke when the timer fires"),
	runAt: z
		.string()
		.describe(
			"When to fire — ISO datetime (e.g. '2026-03-23T17:00:00+01:00') or delay string (e.g. '2h', '30m', '1d')",
		),
	objective: z.string().describe("What the agent should accomplish"),
	hint: z
		.string()
		.optional()
		.describe("Optional instructions forwarded to the agent when it fires"),
});

const dispatchTimerTool: ToolDefinition<typeof dispatchTimerSchema> = {
	name: "dispatch.timer",
	description:
		"Schedule a one-time agent run at a specific time or after a delay. Use for reminders, delayed check-ins, and self-scheduling.",
	inputSchema: dispatchTimerSchema,
	execute: async (input, context) => {
		const absoluteRunAt = parseRunAt(input.runAt);
		const id = crypto.randomUUID();
		await addTimer({
			id,
			agentName: input.agent,
			chatId: context.chatId,
			objective: input.objective,
			...(input.hint ? { hint: input.hint } : {}),
			runAt: absoluteRunAt,
			createdBy: context.agent.name,
			createdAt: new Date().toISOString(),
		});
		return `Timer set for ${input.agent} at ${absoluteRunAt} [${id}]`;
	},
	kind: "builtin",
	capability: "tool",
};

// -- dispatch.list --

const dispatchListSchema = z.object({});

const dispatchListTool: ToolDefinition<typeof dispatchListSchema> = {
	name: "dispatch.list",
	description: "List all active schedules and pending timers.",
	inputSchema: dispatchListSchema,
	execute: async () => {
		const scheduleEntries = getSchedules();
		const timerEntries = listTimers();

		const lines: string[] = [];

		if (scheduleEntries.length > 0) {
			lines.push("**Schedules**");
			for (const s of scheduleEntries) {
				lines.push(
					`• [${s.id}] ${s.agentName} | ${s.pattern} | ${s.label ?? s.objective}`,
				);
			}
		}

		if (timerEntries.length > 0) {
			if (lines.length > 0) lines.push("");
			lines.push("**Timers**");
			for (const t of timerEntries) {
				lines.push(
					`• [${t.id}] ${t.agentName} | fires at ${t.runAt} | ${t.objective}`,
				);
			}
		}

		if (lines.length === 0) return "No active schedules or pending timers.";
		return lines.join("\n");
	},
	kind: "builtin",
	capability: "resource",
};

// -- dispatch.cancel --

const dispatchCancelSchema = z.object({
	id: z.string().describe("ID of the schedule or timer to cancel"),
});

const dispatchCancelTool: ToolDefinition<typeof dispatchCancelSchema> = {
	name: "dispatch.cancel",
	description:
		"Cancel an active schedule or pending timer by ID. Use dispatch.list to find IDs.",
	inputSchema: dispatchCancelSchema,
	execute: async (input) => {
		const removedTimer = await removeTimer(input.id);
		if (removedTimer) return `Cancelled timer ${input.id}`;
		const removedSchedule = await removeSchedule(input.id);
		if (removedSchedule) return `Cancelled schedule ${input.id}`;
		return `No schedule or timer found with ID ${input.id}`;
	},
	kind: "builtin",
	capability: "tool",
	requiresConfirmation: true,
};

export { parseRunAt };

export const dispatchToolset: ToolsetDefinition = {
	name: "dispatch",
	description:
		"Use when you need to dispatch agents, schedule recurring runs, set timers, or manage scheduled jobs.",
	tools: [
		dispatchAgentTool,
		dispatchScheduleTool,
		dispatchTimerTool,
		dispatchListTool,
		dispatchCancelTool,
	],
};
