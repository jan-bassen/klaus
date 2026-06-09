import { z } from "zod";
import {
	addSchedule,
	getSchedules,
	removeSchedule,
	type ScheduleEntry,
} from "../../../infra/store/schedules.ts";
import {
	addTimer,
	listTimers,
	removeTimer,
} from "../../../infra/store/timers.ts";
import { agentRegistry } from "../../../pipeline/agents.ts";
import type { TurnContext } from "../../../pipeline/core.ts";
import { dispatch as dispatchFn } from "../../../pipeline/dispatch.ts";
import { formatTimerRunAt } from "../../time.ts";
import type { ToolDefinition, ToolsetDefinition } from "../index.ts";

// ── run_agent ──────────────────────────────────────────────────────────────

const DEFAULT_AGENT = "dispatch";

interface ScheduleInput {
	agentName: string;
	cron: string;
	task: string;
	label: string;
	overridePresets?: string[] | undefined;
}

function scheduleEntry(
	input: ScheduleInput,
	context: Pick<TurnContext, "agent">,
	id: string,
): ScheduleEntry {
	return {
		id,
		agentName: input.agentName,
		pattern: input.cron,
		objective: input.task,
		label: input.label,
		createdBy: context.agent.name,
		createdAt: new Date().toISOString(),
		...(input.overridePresets?.length
			? { overrides: input.overridePresets }
			: {}),
	};
}

const dispatchSchema = z.object({
	agentName: z
		.string({ error: "agentName must be a non-empty agent name." })
		.min(1, { error: "agentName must be a non-empty agent name." })
		.optional()
		.describe(
			`Agent to invoke. Defaults to "${DEFAULT_AGENT}" (a generic helper).`,
		),
	task: z
		.string({ error: "task must describe what the agent should do." })
		.min(1, { error: "task must describe what the agent should do." })
		.describe("Agent task to accomplish"),
	overridePresets: z
		.array(z.string())
		.optional()
		.describe("Override preset names to apply (e.g. ['voice','large'])"),
	runAt: z
		.string()
		.optional()
		.describe(
			"Omit to run the agent now and return its result to you. Set to a duration (e.g. '2h', '30m') or ISO datetime to schedule a one-shot timer.",
		),
});

const dispatchTool: ToolDefinition<typeof dispatchSchema> = {
	name: "run_agent",
	get description(): string {
		const names = [...agentRegistry.keys()];
		const list =
			names.length > 0 ? ` Available agents: ${names.join(", ")}.` : "";
		return `Run another agent on a task. Omit runAt to run now and return its result to you; set runAt to schedule a one-shot timer.${list}`;
	},
	inputSchema: dispatchSchema,
	execute: async (input, context) => {
		const agent = input.agentName ?? DEFAULT_AGENT;

		if (input.runAt) {
			const runAt = parseRunAt(input.runAt);
			const id = crypto.randomUUID();
			await addTimer({
				id,
				agentName: agent,
				objective: input.task,
				runAt,
				createdBy: context.agent.name,
				createdAt: new Date().toISOString(),
				...(input.overridePresets?.length
					? { overrides: input.overridePresets }
					: {}),
			});
			return `Timer set for @${agent} at ${runAt} [${id}]`;
		}

		const slot: string[] = [];
		const result = await dispatchFn({
			agent,
			prompt: input.task,
			...(input.overridePresets ? { overrides: input.overridePresets } : {}),
			chatId: context.chatId,
			trigger: { kind: "dispatch", parentRunId: context.runId },
			resultCollector: slot,
		});
		return result ?? "done";
	},
};

// ── schedule_agent ─────────────────────────────────────────────────────────

const dispatchScheduleSchema = z.object({
	agentName: z
		.string({ error: "agentName must be the name of the agent to schedule." })
		.min(1, { error: "agentName must be the name of the agent to schedule." })
		.describe("Name of the agent to schedule"),
	cron: z
		.string({ error: "cron must be a cron expression." })
		.min(1, { error: "cron must be a cron expression." })
		.describe("Cron expression (e.g. '0 8 * * 1-5')"),
	task: z
		.string({ error: "task must describe each scheduled agent run." })
		.min(1, { error: "task must describe each scheduled agent run." })
		.describe("Agent task to accomplish on each run"),
	overridePresets: z
		.array(z.string())
		.optional()
		.describe("Override preset names forwarded on each fire"),
	label: z
		.string({ error: "label must briefly name this schedule." })
		.min(1, { error: "label must briefly name this schedule." })
		.describe("Human-readable label for this schedule"),
});

const dispatchScheduleTool: ToolDefinition<typeof dispatchScheduleSchema> = {
	name: "schedule_agent",
	description:
		"Create a recurring schedule that runs an agent on a cron pattern. Use list_agent_runs to see active schedules, cancel_agent_run to remove one.",
	inputSchema: dispatchScheduleSchema,
	execute: async (input, context) => {
		const id = crypto.randomUUID();
		await addSchedule(scheduleEntry(input, context, id));
		return `Scheduled @${input.agentName} with cron "${input.cron}" (${input.label}) [${id}]`;
	},
};

// ── list_agent_runs ────────────────────────────────────────────────────────

const dispatchListSchema = z.object({});

const dispatchListTool: ToolDefinition<typeof dispatchListSchema> = {
	name: "list_agent_runs",
	description: "List all active schedules and pending timers.",
	inputSchema: dispatchListSchema,
	execute: async () => renderList(getSchedules(), listTimers()),
};

function renderList(
	scheduleEntries: ReturnType<typeof getSchedules>,
	timerEntries: ReturnType<typeof listTimers>,
): string {
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
				`• [${t.id}] ${t.agentName} | fires at ${formatTimerRunAt(t.runAt)} (${t.runAt}) | ${t.objective}`,
			);
		}
	}
	return lines.length > 0
		? lines.join("\n")
		: "No active schedules or pending timers.";
}

// ── cancel_agent_run ───────────────────────────────────────────────────────

const dispatchCancelSchema = z.object({
	id: z
		.string({ error: "id must be the schedule or timer ID to cancel." })
		.min(1, { error: "id must be the schedule or timer ID to cancel." })
		.describe("ID of the schedule or timer to cancel"),
});

const dispatchCancelTool: ToolDefinition<typeof dispatchCancelSchema> = {
	name: "cancel_agent_run",
	description:
		"Cancel an active schedule or pending timer by ID. Use list_agent_runs to find IDs.",
	inputSchema: dispatchCancelSchema,
	execute: async (input) => {
		const removedTimer = await removeTimer(input.id);
		if (removedTimer) return `Cancelled timer ${input.id}`;
		const removedSchedule = await removeSchedule(input.id);
		if (removedSchedule) return `Cancelled schedule ${input.id}`;
		return `No schedule or timer found with ID ${input.id}`;
	},
};

// ── helpers ────────────────────────────────────────────────────────────────

const DELAY_RE = /^(\d+)(s|m|h|d)$/;
const DELAY_MULTIPLIERS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

export function parseRunAt(runAt: string): string {
	const match = runAt.match(DELAY_RE);
	if (match) {
		const value = Number(match[1]);
		const unit = match[2] as string;
		const ms = value * (DELAY_MULTIPLIERS[unit] ?? 0);
		return new Date(Date.now() + ms).toISOString();
	}
	const date = new Date(runAt);
	if (Number.isNaN(date.getTime())) {
		throw new Error(
			`Invalid runAt value: "${runAt}". Use ISO datetime or delay string (e.g. "2h", "30m").`,
		);
	}
	return date.toISOString();
}

export const dispatchToolset: ToolsetDefinition = {
	name: "agents",
	description:
		"Run other agents now or later, and manage recurring agent schedules.",
	tools: [
		dispatchTool,
		dispatchScheduleTool,
		dispatchListTool,
		dispatchCancelTool,
	],
};
