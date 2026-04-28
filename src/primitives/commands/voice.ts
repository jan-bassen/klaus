import { settings } from "../../infra/config.ts";
import { readText, writeData } from "../../infra/runtime.ts";
import { updateFrontmatter } from "../../infra/vault/markdown.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import { agentRegistry, getDefaultAgent } from "../../pipeline/agents.ts";
import type { Command } from "./index.ts";

const VALID = new Set(["on", "off", "auto"] as const);
type VoiceMode = "on" | "off" | "auto";

export const voiceCommand: Command = {
	name: "voice",
	aliases: ["v"],
	description: "Show or set voice output for the default agent (on/off/auto)",
	async execute(msg: InboundMessage, args: string[]): Promise<void> {
		const agentName = getDefaultAgent(msg.chatId);
		const def = agentRegistry.get(agentName);

		if (!def) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Default agent "${agentName}" not found in registry.`,
				dedupKey: `${msg.id}:voice-error`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		const current = def.settings.voice;

		if (!args[0]) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} voice: *${current}*`,
				dedupKey: `${msg.id}:voice`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		const input = args[0].toLowerCase() as VoiceMode;
		if (!VALID.has(input)) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Unknown voice setting. Options: on, off, auto`,
				dedupKey: `${msg.id}:voice-unknown`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		if (input === current) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Voice already set to "${input}".`,
				dedupKey: `${msg.id}:voice-noop`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		try {
			const raw = await readText(def.promptPath);
			const updated = updateFrontmatter(raw, (fm) => {
				const s = (fm.settings as Record<string, unknown>) ?? {};
				s.voice = input;
				fm.settings = s;
			});
			await writeData(def.promptPath, updated);
			def.settings.voice = input;

			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} voice set to *${input}*.`,
				dedupKey: `${msg.id}:voice`,
				label: settings.whatsapp.systemLabel,
			});
		} catch (err) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Failed to update voice: ${err instanceof Error ? err.message : String(err)}`,
				dedupKey: `${msg.id}:voice-error`,
				label: settings.whatsapp.systemLabel,
			});
		}
	},
};
