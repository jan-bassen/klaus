import { settings } from "../../infra/config.ts";
import { pauseFutureWork } from "../../infra/future.ts";
import { getSchedules } from "../../infra/store/schedules.ts";
import { listTimers } from "../../infra/store/timers.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import { abortActiveRuns } from "../../pipeline/runs.ts";
import type { Command } from "./index.ts";

export const stopCommand: Command = {
	name: "stop",
	aliases: ["kill"],
	description: "Panic stop: abort active runs and pause schedules/timers",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		const abortedRuns = abortActiveRuns();
		const timers = listTimers().length;
		const schedules = getSchedules().length;
		pauseFutureWork();

		enqueueMessage({
			chatId: msg.chatId,
			content: [
				"Panic stop armed.",
				`Aborted active runs: ${abortedRuns}`,
				`Paused timers: ${timers}`,
				`Paused schedules: ${schedules}`,
				"Use /resume to restart future work.",
			].join("\n"),
			dedupKey: `${msg.id}:stop`,
			label: settings.whatsapp.systemLabel,
		});
	},
};
