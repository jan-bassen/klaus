import type { Command } from "@/commands";
import { agentRegistry, type VoiceMode, voiceModes } from "@/core/agent";
import { getDefaultAgent } from "@/core/defaults";
import { setFrontmatterField } from "@/core/frontmatter";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

const VALID: Set<string> = new Set(voiceModes);

export const voiceCommand: Command = {
	name: "voice",
	aliases: ["v"],
	description: "Show or set the voice mode for the default agent (auto/on/off)",
	async execute(msg: InboundMessage, args: string[]): Promise<void> {
		const agentName = getDefaultAgent(msg.chatId);
		const def = agentRegistry.get(agentName);

		if (!def) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Default agent "${agentName}" not found in registry.`,
				dedupKey: `${msg.id}:voice-error`,
			});
			return;
		}

		// No args — show current mode
		if (!args[0]) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} voice mode: *${def.voiceMode}*`,
				dedupKey: `${msg.id}:voice`,
			});
			return;
		}

		const input = args[0].toLowerCase();
		if (!VALID.has(input)) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Unknown voice mode. Options: ${voiceModes.join(", ")}`,
				dedupKey: `${msg.id}:voice-unknown`,
			});
			return;
		}

		const mode = input as VoiceMode;
		if (def.voiceMode === mode) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Voice mode already set to "${mode}".`,
				dedupKey: `${msg.id}:voice-noop`,
			});
			return;
		}

		try {
			const raw = await Bun.file(def.promptPath).text();
			const updated = setFrontmatterField(raw, "voiceMode", mode);
			await Bun.write(def.promptPath, updated);
			def.voiceMode = mode;

			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} voice mode set to *${mode}*.`,
				dedupKey: `${msg.id}:voice`,
			});
		} catch (err) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Failed to update voice mode: ${err instanceof Error ? err.message : String(err)}`,
				dedupKey: `${msg.id}:voice-error`,
			});
		}
	},
};
