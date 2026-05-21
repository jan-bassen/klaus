import { settings } from "../../infra/config.ts";
import { readText, writeData } from "../../infra/runtime.ts";
import { updateFrontmatter } from "../../infra/vault/markdown.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import { agentRegistry, getDefaultAgent } from "../../pipeline/agents.ts";
import type { Command } from "./index.ts";

const VALID = new Set(["on", "off", "auto"] as const);
type VoiceMode = "on" | "off" | "auto";

function send(msg: InboundMessage, content: string, suffix: string): void {
	enqueueMessage({
		chatId: msg.chatId,
		content,
		dedupKey: `${msg.id}:${suffix}`,
		label: settings.whatsapp.systemLabel,
	});
}

export const voiceCommand: Command = {
	name: "voice",
	aliases: ["v"],
	params: [{ name: "on|off|auto" }],
	description: "Show or set voice setting",
	async execute(msg: InboundMessage, args: string[]): Promise<void> {
		const agentName = getDefaultAgent(msg.chatId);
		const def = agentRegistry.get(agentName);

		if (!def) {
			return send(
				msg,
				`Default agent "${agentName}" not found in registry.`,
				"voice-error",
			);
		}

		const current = def.settings.voice;

		if (!args[0]) {
			return send(msg, `@${agentName} voice: *${current}*`, "voice");
		}

		const input = args[0].toLowerCase() as VoiceMode;
		if (!VALID.has(input)) {
			return send(
				msg,
				`Unknown voice setting. Options: on, off, auto`,
				"voice-unknown",
			);
		}

		if (input === current) {
			return send(msg, `Voice already set to "${input}".`, "voice-noop");
		}

		try {
			const raw = await readText(def.promptPath);
			const updated = updateFrontmatter(raw, (fm) => {
				fm.voice = input;
			});
			await writeData(def.promptPath, updated);
			def.settings.voice = input;

			send(msg, `@${agentName} voice set to *${input}*.`, "voice");
		} catch (err) {
			send(
				msg,
				`Failed to update voice: ${err instanceof Error ? err.message : String(err)}`,
				"voice-error",
			);
		}
	},
};
