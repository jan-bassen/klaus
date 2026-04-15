import { getActiveJobs } from "@/agent/queue";
import { listTimers } from "@/store/timers";
import type { Variable } from "@/variables";

interface TaskEntry {
	kind: "running" | "timer";
	objective: string;
	runAt?: string;
}

/** Running async jobs and pending timers. */
export const tasksVariable: Variable = {
	key: "tasks",
	description: "Running jobs and pending timers",
	async run() {
		const jobs = getActiveJobs();
		const timers = listTimers();
		const active: TaskEntry[] = [
			...jobs.map((j) => ({
				kind: "running" as const,
				objective: j.objective,
			})),
			...timers.map((t) => ({
				kind: "timer" as const,
				objective: t.objective,
				runAt: t.runAt,
			})),
		];
		return { active };
	},
};
