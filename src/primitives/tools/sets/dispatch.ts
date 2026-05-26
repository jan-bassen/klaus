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
import type { ToolDefinition, ToolsetDefinition } from "../index.ts";

// ── dispatch ───────────────────────────────────────────────────────────────

const DEFAULT_AGENT = "dispatch";

interface ScheduleInput {
	agent: string;
	pattern: string;
	prompt: string;
	label: string;
	overrides?: string[] | undefined;
}

function scheduleEntry(
	input: ScheduleInput,
	context: Pick<TurnContext, "agent">,
	id: string,
): ScheduleEntry {
	return {
		id,
		agentName: input.agent,
		pattern: input.pattern,
		objective: input.prompt,
		label: input.label,
		createdBy: context.agent.name,
		createdAt: new Date().toISOString(),
		...(input.overrides?.length ? { overrides: input.overrides } : {}),
	};
}

const dispatchSchema = z.object({
	agent: z
		.string({ error: "agent must be a non-empty agent name." })
		.min(1, { error: "agent must be a non-empty agent name." })
		.optional()
		.describe(
			`Agent to invoke. Defaults to "${DEFAULT_AGENT}" (a generic helper).`,
		),
	prompt: z
		.string({ error: "prompt must describe what the agent should do." })
		.min(1, { error: "prompt must describe what the agent should do." })
		.describe("What the agent should accomplish"),
	overrides: z
		.array(z.string())
		.optional()
		.describe("Override preset names to apply (e.g. ['voice','large'])"),
	when: z
		.string()
		.optional()
		.describe(
			"Omit to run inline now and return the reply to the caller. Set to a duration (e.g. '2h', '30m') or ISO datetime to schedule a one-shot timer.",
		),
});

const dispatchTool: ToolDefinition<typeof dispatchSchema> = {
	name: "dispatch",
	get description(): string {
		const names = [...agentRegistry.keys()];
		const list =
			names.length > 0 ? ` Available agents: ${names.join(", ")}.` : "";
		return `Invoke another agent. Omit \`when\` to run inline and return its reply to you; set \`when\` to schedule a one-shot timer.${list}`;
	},
	inputSchema: dispatchSchema,
	execute: async (input, context) => {
		const agent = input.agent ?? DEFAULT_AGENT;

		if (input.when) {
			const runAt = parseRunAt(input.when);
			const id = crypto.randomUUID();
			await addTimer({
				id,
				agentName: agent,
				objective: input.prompt,
				runAt,
				createdBy: context.agent.name,
				createdAt: new Date().toISOString(),
				...(input.overrides?.length ? { overrides: input.overrides } : {}),
			});
			return `Timer set for @${agent} at ${runAt} [${id}]`;
		}

		const slot: string[] = [];
		const result = await dispatchFn({
			agent,
			prompt: input.prompt,
			...(input.overrides ? { overrides: input.overrides } : {}),
			chatId: context.chatId,
			trigger: { kind: "dispatch", parentRunId: context.runId },
			replyCollector: slot,
		});
		return result ?? "done";
	},
};

// ── dispatch_schedule ──────────────────────────────────────────────────────

const dispatchScheduleSchema = z.object({
	agent: z
		.string({ error: "agent must be the name of the agent to schedule." })
		.min(1, { error: "agent must be the name of the agent to schedule." })
		.describe("Name of the agent to schedule"),
	pattern: z
		.string({ error: "pattern must be a cron expression." })
		.min(1, { error: "pattern must be a cron expression." })
		.describe("Cron expression (e.g. '0 8 * * 1-5')"),
	prompt: z
		.string({ error: "prompt must describe each scheduled run." })
		.min(1, { error: "prompt must describe each scheduled run." })
		.describe("What the agent should accomplish on each run"),
	overrides: z
		.array(z.string())
		.optional()
		.describe("Override preset names forwarded on each fire"),
	label: z
		.string({ error: "label must briefly name this schedule." })
		.min(1, { error: "label must briefly name this schedule." })
		.describe("Human-readable label for this schedule"),
});

const dispatchScheduleTool: ToolDefinition<typeof dispatchScheduleSchema> = {
	name: "dispatch_schedule",
	description:
		"Create a recurring schedule that invokes an agent on a cron pattern. Use `dispatch_list` to see active schedules, `dispatch_cancel` to remove one.",
	inputSchema: dispatchScheduleSchema,
	execute: async (input, context) => {
		const id = crypto.randomUUID();
		await addSchedule(scheduleEntry(input, context, id));
		return `Scheduled @${input.agent} with pattern "${input.pattern}" (${input.label}) [${id}]`;
	},
};

// ── dispatch_list ──────────────────────────────────────────────────────────

const dispatchListSchema = z.object({});

const dispatchListTool: ToolDefinition<typeof dispatchListSchema> = {
	name: "dispatch_list",
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
				`• [${t.id}] ${t.agentName} | fires at ${t.runAt} | ${t.objective}`,
			);
		}
	}
	return lines.length > 0
		? lines.join("\n")
		: "No active schedules or pending timers.";
}

// ── dispatch_cancel ────────────────────────────────────────────────────────

const dispatchCancelSchema = z.object({
	id: z
		.string({ error: "id must be the schedule or timer ID to cancel." })
		.min(1, { error: "id must be the schedule or timer ID to cancel." })
		.describe("ID of the schedule or timer to cancel"),
});

const dispatchCancelTool: ToolDefinition<typeof dispatchCancelSchema> = {
	name: "dispatch_cancel",
	description:
		"Cancel an active schedule or pending timer by ID. Use `dispatch_list` to find IDs.",
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
			`Invalid when value: "${runAt}". Use ISO datetime or delay string (e.g. "2h", "30m").`,
		);
	}
	return date.toISOString();
}

export const dispatchToolset: ToolsetDefinition = {
	name: "dispatch",
	description:
		"Invoke other agents (inline or via timer) and manage recurring schedules.",
	tools: [
		dispatchTool,
		dispatchScheduleTool,
		dispatchListTool,
		dispatchCancelTool,
	],
};
