import { settings } from "../../infra/config.ts";
import { pauseFutureWork } from "../../infra/future.ts";
import { getSchedules } from "../../infra/store/schedules.ts";
import { listTimers } from "../../infra/store/timers.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import type { Command } from "./index.ts";

export const pauseCommand: Command = {
	name: "pause",
	description: "Pause schedules and timers without aborting active runs",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		const timers = listTimers().length;
		const schedules = getSchedules().length;
		pauseFutureWork();

		enqueueMessage({
			chatId: msg.chatId,
			content: [
				"Future work paused.",
				`Paused timers: ${timers}`,
				`Paused schedules: ${schedules}`,
				"Use /resume to restart future work.",
			].join("\n"),
			dedupKey: `${msg.id}:pause`,
			label: settings.whatsapp.systemLabel,
		});
	},
};
