import type { Command } from "@/commands";
import { type AcceptMode, acceptModes, agentRegistry } from "@/core/agent";
import { getDefaultAgent } from "@/core/defaults";
import { setFrontmatterField } from "@/core/frontmatter";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

const VALID: Set<string> = new Set(acceptModes);

export const acceptCommand: Command = {
	name: "accept",
	aliases: ["a"],
	description:
		"Show or set the auto-accept mode for the default agent (on/off)",
	async execute(msg: InboundMessage, args: string[]): Promise<void> {
		const agentName = getDefaultAgent(msg.chatId);
		const def = agentRegistry.get(agentName);

		if (!def) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Default agent "${agentName}" not found in registry.`,
				dedupKey: `${msg.id}:accept-error`,
			});
			return;
		}

		// No args — show current mode
		if (!args[0]) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} accept mode: *${def.acceptMode}*`,
				dedupKey: `${msg.id}:accept`,
			});
			return;
		}

		const input = args[0].toLowerCase();
		if (!VALID.has(input)) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Unknown accept mode. Options: ${acceptModes.join(", ")}`,
				dedupKey: `${msg.id}:accept-unknown`,
			});
			return;
		}

		const mode = input as AcceptMode;
		if (def.acceptMode === mode) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Accept mode already set to "${mode}".`,
				dedupKey: `${msg.id}:accept-noop`,
			});
			return;
		}

		try {
			const raw = await Bun.file(def.promptPath).text();
			const updated = setFrontmatterField(raw, "acceptMode", mode);
			await Bun.write(def.promptPath, updated);
			def.acceptMode = mode;

			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} accept mode set to *${mode}*.`,
				dedupKey: `${msg.id}:accept`,
			});
		} catch (err) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Failed to update accept mode: ${err instanceof Error ? err.message : String(err)}`,
				dedupKey: `${msg.id}:accept-error`,
			});
		}
	},
};
