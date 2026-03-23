import { getActiveJobs } from "@/core/queue";
import { listTimers } from "@/store/timers";
import type { ContextVariable, ContextVariableResult } from "@/types";

/** Provides active_tasks: running async jobs and pending timers. */
export const activeTasksQuery: ContextVariable = {
	name: "active_tasks",
	priority: 4,
	run: async (): Promise<ContextVariableResult> => {
		const jobs = getActiveJobs();
		const timers = listTimers();

		if (jobs.length === 0 && timers.length === 0)
			return { content: "", tokenCount: 0, truncate: "always" };

		const lines: string[] = [];

		for (const job of jobs) {
			lines.push(`- [running] ${job.objective}`);
		}
		for (const timer of timers) {
			lines.push(`- [timer ${timer.runAt}] ${timer.objective}`);
		}

		const content = lines.join("\n");
		const tokenCount = Math.ceil(content.length / 4);
		return { content, tokenCount, truncate: "always" };
	},
};
