import { settings } from "../../infra/config.ts";
import { type ReportEntry, readReports } from "../../infra/store/report.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import type { Command } from "./index.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function summarize(e: ReportEntry): string {
	const outcome =
		e.outcome.kind === "ok" ? "ok" : `error: ${e.outcome.error.name}`;
	const llm = e.llm
		? ` | ${e.llm.model} ${e.llm.usage.promptTokens}↑/${e.llm.usage.completionTokens}↓ (${e.llm.steps.length} steps)`
		: "";
	const sim = e.simulation ? " ⚠ SIM" : "";
	return `${e.timestamp} @${e.agent} (${e.trigger.kind}) — ${outcome} in ${e.durationMs}ms${llm}${sim}`;
}

export const reportsCommand: Command = {
	name: "reports",
	aliases: ["rep"],
	params: [{ name: "limit" }, { name: "agent" }],
	description: "List recent reports",
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
			? entries.map(summarize).join("\n")
			: "_No reports yet._";

		enqueueMessage({
			chatId: msg.chatId,
			content: `*Reports*${agent ? ` @${agent}` : ""}\n${content}`,
			dedupKey: `${msg.id}:reports`,
			label: settings.whatsapp.systemLabel,
		});
	},
};
