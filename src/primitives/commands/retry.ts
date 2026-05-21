import { settings } from "../../infra/config.ts";
import { getConversation } from "../../infra/store/history.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import { handleTurn } from "../../pipeline/index.ts";
import type { Command } from "./index.ts";

/**
 * Find the most recent failed turn and rebuild the routed user prompt that
 * produced it.
 */
async function selectTarget(): Promise<
	{ text: string; agent: string; overrides: string[] } | { error: string }
> {
	const history = await getConversation();

	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i];
		if (m?.role !== "assistant" || !m.failed) continue;
		if (!m.agent) {
			return { error: "Couldn't retry that failed turn: missing agent route." };
		}
		for (let j = i - 1; j >= 0; j--) {
			const u = history[j];
			if (u?.role === "user" && u.content) {
				return {
					text: u.content,
					agent: m.agent,
					overrides: u.overrides ?? [],
				};
			}
		}
		return { error: "Couldn't find the user message before the failed turn." };
	}
	return {
		error: "Nothing to retry — no failed turn found.",
	};
}

function replayText(target: {
	text: string;
	agent: string;
	overrides: string[];
}): string {
	return [
		`@${target.agent}`,
		...target.overrides.map((name) => `!${name}`),
		target.text,
	]
		.join(" ")
		.trim();
}

export const retryCommand: Command = {
	name: "retry",
	aliases: ["r"],
	description: "Re-run the most recent failed turn",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		const target = await selectTarget();
		if ("error" in target) {
			enqueueMessage({
				chatId: msg.chatId,
				content: target.error,
				dedupKey: `${msg.id}:retry-err`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		const replay: InboundMessage = {
			kind: "whatsapp",
			id: crypto.randomUUID(),
			chatId: msg.chatId,
			senderId: msg.senderId,
			text: replayText(target),
			timestamp: new Date(),
			messageKey: msg.messageKey,
		};
		await handleTurn(replay);
	},
};
