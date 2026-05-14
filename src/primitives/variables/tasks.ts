import { getSchedules } from "../../infra/store/schedules.ts";
import { listTimers } from "../../infra/store/timers.ts";
import type { Variable } from "./index.ts";

type TaskEntry =
	| { kind: "timer"; objective: string; runAt: string }
	| { kind: "schedule"; objective: string; pattern: string; label?: string };

/** Pending timers and schedules. */
export const tasksVariable: Variable = {
	key: "tasks",
	description: "Pending timers and schedules",
	async run() {
		const active: TaskEntry[] = [
			...listTimers().map(
				(t): TaskEntry => ({
					kind: "timer",
					objective: t.objective,
					runAt: t.runAt,
				}),
			),
			...getSchedules().map(
				(s): TaskEntry => ({
					kind: "schedule",
					objective: s.objective,
					pattern: s.pattern,
					...(s.label ? { label: s.label } : {}),
				}),
			),
		];
		return { active };
	},
};
