import type { Command } from "@/commands";
import { config } from "@/config";
import { QUERIES } from "@/db/queries";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

const timeFormatter = new Intl.DateTimeFormat(config.locale, {
	hour: "2-digit",
	minute: "2-digit",
	timeZone: config.timezone,
});

export const tasksCommand: Command = {
	name: "tasks",
	description: "List active tasks",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		try {
			const result = await QUERIES.active_tasks?.({ chatId: msg.chatId });
			const tasks = result as {
				id: string;
				assignedTo: string | null;
				objective: string;
				createdAt: Date;
			}[];

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
				const since = timeFormatter.format(t.createdAt);
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
				content: "Could not load tasks — database error.",
				dedupKey: `${msg.id}:tasks-error`,
			});
		}
	},
};
