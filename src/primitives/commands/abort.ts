import { settings } from "../../infra/config.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import { abortActiveRuns } from "../../pipeline/runs.ts";
import type { Command } from "./index.ts";

export const abortCommand: Command = {
	name: "abort",
	description: "Abort active runs without pausing schedules or timers",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		const abortedRuns = abortActiveRuns();

		enqueueMessage({
			chatId: msg.chatId,
			content: `Aborted active runs: ${abortedRuns}`,
			dedupKey: `${msg.id}:abort`,
			label: settings.whatsapp.systemLabel,
		});
	},
};
