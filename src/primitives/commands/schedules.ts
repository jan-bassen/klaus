import { settings } from "../../infra/config.ts";
import { getSchedules } from "../../infra/store/schedules.ts";
import { listTimers } from "../../infra/store/timers.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import type { Command } from "./index.ts";

const timeFormatter = new Intl.DateTimeFormat(settings.locale, {
	hour: "2-digit",
	minute: "2-digit",
	timeZone: settings.timezone,
});

export const schedulesCommand: Command = {
	name: "schedules",
	aliases: ["s"],
	description: "List schedules and timers",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		try {
			const schedules = getSchedules();
			const timers = listTimers();

			if (schedules.length === 0 && timers.length === 0) {
				enqueueMessage({
					chatId: msg.chatId,
					content: "No active schedules or timers.",
					dedupKey: `${msg.id}:schedules`,
					label: settings.whatsapp.systemLabel,
				});
				return;
			}

			const lines: string[] = [];

			if (schedules.length > 0) {
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
				dedupKey: `${msg.id}:schedules`,
				label: settings.whatsapp.systemLabel,
			});
		} catch {
			enqueueMessage({
				chatId: msg.chatId,
				content: "Could not load schedules.",
				dedupKey: `${msg.id}:schedules-error`,
				label: settings.whatsapp.systemLabel,
			});
		}
	},
};
