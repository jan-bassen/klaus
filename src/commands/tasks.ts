import type { Command } from "@/commands";
import { getActiveJobs } from "@/core/queue";
import { settings } from "@/settings";
import { getSchedules } from "@/store/schedules";
import { listTimers } from "@/store/timers";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

const timeFormatter = new Intl.DateTimeFormat(settings.locale, {
	hour: "2-digit",
	minute: "2-digit",
	timeZone: settings.timezone,
});

export const tasksCommand: Command = {
	name: "tasks",
	aliases: ["t"],
	description: "List active jobs, schedules, and timers",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		try {
			const jobs = getActiveJobs();
			const schedules = getSchedules();
			const timers = listTimers();

			if (jobs.length === 0 && schedules.length === 0 && timers.length === 0) {
				enqueueMessage({
					chatId: msg.chatId,
					content: "No active jobs, schedules, or timers.",
					dedupKey: `${msg.id}:tasks`,
					label: settings.whatsapp.systemLabel,
				});
				return;
			}

			const lines: string[] = [];

			if (jobs.length > 0) {
				lines.push(`*Active jobs* (${jobs.length})`);
				for (const job of jobs) {
					const since = timeFormatter.format(new Date(job.startedAt));
					lines.push(`• ${job.agentName} — ${job.objective} (since ${since})`);
				}
			}

			if (schedules.length > 0) {
				if (lines.length > 0) lines.push("");
				lines.push(`*Schedules* (${schedules.length})`);
				for (const s of schedules) {
					lines.push(
						`• ${s.agentName} — ${s.pattern} — ${s.label ?? s.objective}`,
					);
				}
			}

			if (timers.length > 0) {
				if (lines.length > 0) lines.push("");
				lines.push(`*Timers* (${timers.length})`);
				for (const t of timers) {
					const at = timeFormatter.format(new Date(t.runAt));
					lines.push(`• ${t.agentName} — ${t.objective} (at ${at})`);
				}
			}

			enqueueMessage({
				chatId: msg.chatId,
				content: lines.join("\n"),
				dedupKey: `${msg.id}:tasks`,
				label: settings.whatsapp.systemLabel,
			});
		} catch {
			enqueueMessage({
				chatId: msg.chatId,
				content: "Could not load tasks.",
				dedupKey: `${msg.id}:tasks-error`,
				label: settings.whatsapp.systemLabel,
			});
		}
	},
};
