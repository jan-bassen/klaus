import path from "node:path";
import type { Command } from "@/commands";
import { settings } from "@/config";
import { runEvalFile } from "@/eval/runner";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

export const evalCommand: Command = {
	name: "eval",
	description: "Run prompt evals for an agent: /eval <agent> [case]",
	async execute(msg: InboundMessage, args: string[]): Promise<void> {
		const agentName = args[0];
		if (!agentName) {
			enqueueMessage({
				chatId: msg.chatId,
				content: "Usage: /eval <agent> [case]",
				dedupKey: `${msg.id}:eval`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		const caseFilter = args[1];
		const evalsDir = path.join(settings.vault.internalPath, "evals");
		const filePath = path.join(evalsDir, `${agentName}.yml`);

		enqueueMessage({
			chatId: msg.chatId,
			content: `Running eval for @${agentName}${caseFilter ? ` (case: ${caseFilter})` : ""}…`,
			dedupKey: `${msg.id}:eval-start`,
			label: settings.whatsapp.systemLabel,
		});

		try {
			const result = await runEvalFile(filePath, caseFilter);

			const lines: string[] = [];
			let casesPass = 0;
			let criteriaPass = 0;
			let criteriaTotal = 0;

			for (const c of result.cases) {
				if (c.error) {
					lines.push(`ERR  ${c.name}: ${c.error}`);
					continue;
				}

				criteriaTotal += c.judgments.length;
				const cp = c.judgments.filter((j) => j.pass).length;
				criteriaPass += cp;

				if (c.passed) {
					casesPass++;
					lines.push(`PASS  ${c.name}`);
				} else {
					lines.push(`FAIL  ${c.name}`);
					for (const j of c.judgments) {
						if (!j.pass) {
							lines.push(`  - ${j.criterion}: ${j.reason}`);
						}
					}
				}
			}

			const total = result.cases.length;
			const summary = `*Eval: @${agentName}* (${result.model})\n${lines.join("\n")}\n\n${casesPass}/${total} passed | ${criteriaPass}/${criteriaTotal} criteria`;

			enqueueMessage({
				chatId: msg.chatId,
				content: summary,
				dedupKey: `${msg.id}:eval-result`,
				label: settings.whatsapp.systemLabel,
			});
		} catch (err) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Eval failed: ${err instanceof Error ? err.message : String(err)}`,
				dedupKey: `${msg.id}:eval-error`,
				label: settings.whatsapp.systemLabel,
			});
		}
	},
};
