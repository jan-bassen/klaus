import { settings } from "@/infra/config";
import { readReports } from "@/infra/store/report";
import { enqueueMessage } from "@/infra/whatsapp/send";
import { renderTemplate } from "@/pipeline/prompts";
import type { Command } from "@/primitives/commands";
import type { InboundMessage } from "@/infra/whatsapp/receive";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export const reportsCommand: Command = {
	name: "reports",
	aliases: ["rep"],
	description:
		"List recent agent reports. Optional args: a numeric limit and/or an agent filter (e.g. `/reports 5 assistant`).",
	async execute(msg: InboundMessage, args: string[]): Promise<void> {
		let limit = DEFAULT_LIMIT;
		let agent: string | undefined;
		for (const a of args) {
			const n = Number(a);
			if (Number.isFinite(n) && n > 0) {
				limit = Math.min(MAX_LIMIT, Math.floor(n));
			} else {
				agent = a.replace(/^@/, "");
			}
		}

		const entries = await readReports({
			limit,
			...(agent ? { agent } : {}),
			chatId: msg.chatId,
		});

		const content = entries.length
			? entries
					.map((e) =>
						renderTemplate(
							"report-short",
							e as unknown as Record<string, unknown>,
						),
					)
					.join("\n")
			: "_No reports yet._";

		enqueueMessage({
			chatId: msg.chatId,
			content: `*Reports*${agent ? ` @${agent}` : ""}\n${content}`,
			dedupKey: `${msg.id}:reports`,
			label: settings.whatsapp.systemLabel,
		});
	},
};
