import type { Variable } from "@/primitives/variables";

/**
 * What kicked off this agent run. Templates branch on `kind`:
 *   - `message`  → user-typed WhatsApp message (`messageId` is the WhatsApp id)
 *   - `schedule` → cron-fired (`scheduleId` references the schedule entry)
 *   - `timer`    → one-shot timer (`timerId` references the timer entry)
 *   - `dispatch` → another agent invoked us (`parentRunId` is the parent run)
 *
 * Always present — every run has a trigger.
 */
export const triggerVariable: Variable = {
	key: "trigger",
	description: "What kicked off this agent run (kind + source id)",
	hidden: true,
	async run(turn) {
		return turn.trigger;
	},
};
