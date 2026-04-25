import { settings } from "@/infra/config";
import { updateFrontmatter } from "@/infra/vault/markdown";
import type { InboundMessage } from "@/infra/whatsapp/receive";
import { enqueueMessage } from "@/infra/whatsapp/send";
import { agentRegistry, getDefaultAgent } from "@/pipeline/agents";
import type { Command } from "@/primitives/commands";

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

		const current = def.settings.accept ? "on" : "off";

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
			const raw = await Bun.file(def.promptPath).text();
			const updated = updateFrontmatter(raw, (fm) => {
				const s = (fm.settings as Record<string, unknown>) ?? {};
				s.accept = input === "on";
				fm.settings = s;
			});
			await Bun.write(def.promptPath, updated);
			def.settings.accept = input === "on";

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
