import { listTimers } from "../../infra/store/timers.ts";
import type { Variable } from "./index.ts";

interface TaskEntry {
	kind: "timer";
	objective: string;
	runAt?: string;
}

/** Pending timers. */
export const tasksVariable: Variable = {
	key: "tasks",
	description: "Pending timers",
	async run() {
		const timers = listTimers();
		const active: TaskEntry[] = timers.map((t) => ({
			kind: "timer" as const,
			objective: t.objective,
			runAt: t.runAt,
		}));
		return { active };
	},
};
