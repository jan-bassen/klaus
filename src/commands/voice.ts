import { agentRegistry, getDefaultAgent } from "@/agent/definitions";
import type { Command } from "@/commands";
import { settings } from "@/config";
import { removeFrontmatterField, setFrontmatterField } from "@/markdown";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

const VALID = new Set(["on", "off", "auto"]);

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

		// Derive current state from frontmatter overrides
		const current = def.forceVoice ? "on" : def.suppressVoice ? "off" : "auto";

		// No args — show current state
		if (!args[0]) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} voice: *${current}*`,
				dedupKey: `${msg.id}:voice`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		const input = args[0].toLowerCase();
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
			let raw = await Bun.file(def.promptPath).text();

			if (input === "on") {
				raw = setFrontmatterField(raw, "forceVoice", "true");
				raw = removeFrontmatterField(raw, "suppressVoice");
				def.forceVoice = true;
				def.suppressVoice = undefined;
			} else if (input === "off") {
				raw = setFrontmatterField(raw, "suppressVoice", "true");
				raw = removeFrontmatterField(raw, "forceVoice");
				def.suppressVoice = true;
				def.forceVoice = undefined;
			} else {
				// auto — remove both
				raw = removeFrontmatterField(raw, "forceVoice");
				raw = removeFrontmatterField(raw, "suppressVoice");
				def.forceVoice = undefined;
				def.suppressVoice = undefined;
			}

			await Bun.write(def.promptPath, raw);

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
