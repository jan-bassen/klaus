import type { Command } from "@/commands";
import { settings } from "@/settings";
import { listTasks } from "@/store/tasks";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

const timeFormatter = new Intl.DateTimeFormat(settings.locale, {
	hour: "2-digit",
	minute: "2-digit",
	timeZone: settings.timezone,
});

export const tasksCommand: Command = {
	name: "tasks",
	description: "List active tasks",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		try {
			const tasks = await listTasks({ status: ["pending", "running"] });

			if (tasks.length === 0) {
				enqueueMessage({
					chatId: msg.chatId,
					content: "No active tasks.",
					dedupKey: `${msg.id}:tasks`,
				});
				return;
			}

			const lines = tasks.map((t) => {
				const agent = t.assignedTo ?? "unknown";
				const since = timeFormatter.format(new Date(t.createdAt));
				return `• ${agent} — ${t.objective} (since ${since})`;
			});

			enqueueMessage({
				chatId: msg.chatId,
				content: `*Active tasks* (${tasks.length})\n${lines.join("\n")}`,
				dedupKey: `${msg.id}:tasks`,
			});
		} catch {
			enqueueMessage({
				chatId: msg.chatId,
				content: "Could not load tasks.",
				dedupKey: `${msg.id}:tasks-error`,
			});
		}
	},
};
