import { settings } from "../../infra/config.ts";
import { resumeFutureWorkIfReady } from "../../infra/future.ts";
import { getSchedules } from "../../infra/store/schedules.ts";
import { listTimers } from "../../infra/store/timers.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import type { Command } from "./index.ts";

export const resumeCommand: Command = {
	name: "resume",
	description: "Resume schedules and timers after /stop",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		const active = resumeFutureWorkIfReady();
		const timers = listTimers().length;
		const schedules = getSchedules().length;
		const status = active
			? "Future work resumed."
			: "Future work unpaused, but waiting for setup or WhatsApp connection.";

		enqueueMessage({
			chatId: msg.chatId,
			content: [
				status,
				`Timers ready: ${timers}`,
				`Schedules ready: ${schedules}`,
			].join("\n"),
			dedupKey: `${msg.id}:resume`,
			label: settings.whatsapp.systemLabel,
		});
	},
};
