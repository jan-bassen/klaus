import type { ScheduleEntry } from "../infra/store/schedules.ts";
import type { AgentDefinition } from "./agents.ts";

type AgentSchedule = AgentDefinition["schedules"][number];

export function frontmatterScheduleId(
	agentName: string,
	index: number,
): string {
	return `frontmatter:${agentName}:${index}`;
}

export function frontmatterScheduleEntry(
	agentName: string,
	index: number,
	schedule: AgentSchedule,
): ScheduleEntry {
	return {
		id: frontmatterScheduleId(agentName, index),
		agentName,
		pattern: schedule.pattern,
		objective: "# Message",
		...(schedule.overrides.length > 0 ? { overrides: schedule.overrides } : {}),
		...(schedule.label ? { label: schedule.label } : {}),
		createdBy: "scheduler",
		createdAt: new Date().toISOString(),
	};
}
