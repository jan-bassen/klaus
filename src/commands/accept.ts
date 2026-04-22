import { agentRegistry, getDefaultAgent } from "@/agent/definitions";
import type { Command } from "@/commands";
import { settings } from "@/config";
import { removeFrontmatterField, setFrontmatterField } from "@/markdown";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

export const acceptCommand: Command = {
	name: "accept",
	aliases: ["a"],
	description: "Show or set auto-accept for the default agent (on/off)",
	async execute(msg: InboundMessage, args: string[]): Promise<void> {
		const agentName = getDefaultAgent(msg.chatId);
		const def = agentRegistry.get(agentName);

		if (!def) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Default agent "${agentName}" not found in registry.`,
				dedupKey: `${msg.id}:accept-error`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		const current = def.autoAccept ? "on" : "off";

		// No args — show current state
		if (!args[0]) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} auto-accept: *${current}*`,
				dedupKey: `${msg.id}:accept`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		const input = args[0].toLowerCase();
		if (input !== "on" && input !== "off") {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Unknown option. Use: on, off`,
				dedupKey: `${msg.id}:accept-unknown`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		if (input === current) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Auto-accept already set to "${input}".`,
				dedupKey: `${msg.id}:accept-noop`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		try {
			let raw = await Bun.file(def.promptPath).text();

			if (input === "on") {
				raw = setFrontmatterField(raw, "autoAccept", "true");
				def.autoAccept = true;
			} else {
				raw = removeFrontmatterField(raw, "autoAccept");
				def.autoAccept = undefined;
			}

			await Bun.write(def.promptPath, raw);

			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} auto-accept set to *${input}*.`,
				dedupKey: `${msg.id}:accept`,
				label: settings.whatsapp.systemLabel,
			});
		} catch (err) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Failed to update auto-accept: ${err instanceof Error ? err.message : String(err)}`,
				dedupKey: `${msg.id}:accept-error`,
				label: settings.whatsapp.systemLabel,
			});
		}
	},
};
