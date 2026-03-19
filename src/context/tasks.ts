import { listTasks } from "@/store/tasks";
import type {
	ContextVariable,
	ContextVariableResult,
	TurnContext,
} from "@/types";

/** Renders a single task list item with optional indentation. */
function formatTaskItem(status: string, objective: string, indent = 0): string {
	const prefix = "  ".repeat(indent);
	return `${prefix}- [${status}] ${objective}`;
}

/** Provides active_tasks: all non-terminal tasks, showing chain structure. */
export const activeTasksQuery: ContextVariable = {
	name: "active_tasks",
	priority: 4,
	run: async (
		_turn: Omit<TurnContext, "assembled">,
	): Promise<ContextVariableResult> => {
		const rows = await listTasks({ status: ["pending", "running"] });

		if (rows.length === 0)
			return { content: "", tokenCount: 0, truncate: "always" };

		// Separate top-level tasks (no parent) from chain children.
		const topLevel = rows.filter((t) => !t.parentTaskId);
		const children = rows.filter((t) => t.parentTaskId);

		const lines: string[] = [];
		for (const t of topLevel) {
			lines.push(formatTaskItem(t.status, t.objective));
			for (const child of children.filter((c) => c.parentTaskId === t.id)) {
				lines.push(formatTaskItem(child.status, child.objective, 1));
			}
		}
		// Any children whose parent is not itself active.
		const topLevelIds = new Set(topLevel.map((t) => t.id));
		for (const child of children.filter(
			(c) => c.parentTaskId && !topLevelIds.has(c.parentTaskId),
		)) {
			lines.push(formatTaskItem(child.status, child.objective));
		}

		const content = lines.join("\n");
		const tokenCount = Math.ceil(content.length / 4);
		return { content, tokenCount, truncate: "always" };
	},
};
