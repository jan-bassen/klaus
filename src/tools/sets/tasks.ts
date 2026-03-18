import { z } from "zod";
import { dispatch as dispatchAgent } from "@/core/dispatch";
import { agentRegistry } from "@/core/agent";
import { getTask, listTasks, moveTask } from "@/store/tasks";
import type { ToolDefinition, ToolsetDefinition } from "@/types";

// dispatch
const taskDispatchSchema = z.object({
	agent: z
		.string()
		.describe("Name of the agent to invoke. See tool description for available agents."),
	objective: z.string().describe("What the agent should accomplish"),
	hint: z
		.string()
		.optional()
		.describe("Optional additional context or instructions for the agent"),
	mode: z
		.enum(["async", "inline"])
		.default("async")
		.describe(
			"async: fire-and-forget background job (returns task ID); inline: run now and return result",
		),
});

export const taskDispatchTool: ToolDefinition<typeof taskDispatchSchema> = {
	name: "tasks.dispatch",
	get description(): string {
		const names = [...agentRegistry.keys()];
		const list =
			names.length > 0 ? ` Available agents: ${names.join(", ")}.` : "";
		return `Invoke another agent with an objective.${list} Use async for background work, inline to await the result.`;
	},
	inputSchema: taskDispatchSchema,
	execute: async (input, context) => {
		const result = await dispatchAgent({
			agent: input.agent,
			objective: input.objective,
			...(input.hint ? { hint: input.hint } : {}),
			mode: input.mode === "inline" ? { kind: "inline" } : { kind: "async" },
			chatId: context.chatId,
			caller: context.agent.name,
			...(context.taskId ? { parentTaskId: context.taskId } : {}),
		});
		if (input.mode === "async") {
			return `Dispatched ${input.agent} (task: ${result ?? "unknown"})`;
		}
		return result ?? "done";
	},
	kind: "builtin",
	capability: "tool",
};

// tasks.cancel
const taskCancelSchema = z.object({
	taskId: z.string().uuid(),
});

export const taskCancelTool: ToolDefinition<typeof taskCancelSchema> = {
	name: "tasks.cancel",
	description: "Cancel a pending or running task.",
	inputSchema: taskCancelSchema,
	execute: async (input) => {
		const task = await getTask(input.taskId);
		if (!task) return `Task ${input.taskId} not found.`;
		if (["done", "failed", "cancelled"].includes(task.status))
			return `Task already ${task.status}.`;
		await moveTask(input.taskId, "cancelled");
		return `Cancelled task ${input.taskId}`;
	},
	kind: "builtin",
	capability: "tool",
};

// tasks.list
const taskListSchema = z.object({
	status: z
		.enum(["pending", "running", "done", "failed", "cancelled"])
		.optional(),
});

export const taskListTool: ToolDefinition<typeof taskListSchema> = {
	name: "tasks.list",
	description: "List tasks, optionally filtered by status.",
	inputSchema: taskListSchema,
	execute: async (input, context) => {
		const rows = await listTasks({
			...(input.status ? { status: input.status } : {}),
			chatId: context.chatId,
		});
		if (rows.length === 0) return "No tasks found.";
		return rows
			.slice(0, 20)
			.map(
				(t) => `[${t.id}] ${t.assignedTo ?? "?"} — ${t.status}: ${t.objective}`,
			)
			.join("\n");
	},
	kind: "builtin",
	capability: "resource",
};

// tasks.get
const taskGetSchema = z.object({
	taskId: z.string().uuid().describe("Task ID to inspect"),
});

export const taskGetTool: ToolDefinition<typeof taskGetSchema> = {
	name: "tasks.get",
	description:
		"Fetch the full details of a task by ID, including status, timing, and result.",
	inputSchema: taskGetSchema,
	execute: async (input) => {
		const task = await getTask(input.taskId);
		if (!task) return `Task ${input.taskId} not found.`;
		const lines = [
			`ID:         ${task.id}`,
			`Status:     ${task.status}`,
			`Agent:      ${task.assignedTo ?? "—"}`,
			`Caller:     ${task.caller ?? "—"}`,
			`Objective:  ${task.objective}`,
			`Parent:     ${task.parentTaskId ?? "—"}`,
			`Created:    ${task.createdAt}`,
			`Completed:  ${task.completedAt ?? "—"}`,
			`Result:     ${task.result != null ? JSON.stringify(task.result, null, 2) : "—"}`,
		];
		return lines.join("\n");
	},
	kind: "builtin",
	capability: "resource",
};

export const taskToolset: ToolsetDefinition = {
	name: "tasks",
	description:
		"Use when you need to dispatch agents, cancel tasks, or list running tasks.",
	tools: [taskDispatchTool, taskCancelTool, taskListTool, taskGetTool],
};
