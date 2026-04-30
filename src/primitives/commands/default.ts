import { settings, updateDefaultAgent } from "../../infra/config.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import {
	agentRegistry,
	loadAgentDefinition,
	setDefaultAgent,
} from "../../pipeline/agents.ts";
import type { Command } from "./index.ts";

export const defaultCommand: Command = {
	name: "default",
	params: [{ name: "agent" }],
	description: "Change the default agent",
	async execute(msg: InboundMessage, args: string[]): Promise<void> {
		const agentName = args[0];

		if (!agentName) {
			enqueueMessage({
				chatId: msg.chatId,
				content: "Provide a name! Usage: /default <agent_name>",
				dedupKey: `${msg.id}:default-usage`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		// Check registry first
		if (agentRegistry.get(agentName)) {
			setDefaultAgent(msg.chatId, agentName);
			await updateDefaultAgent(agentName);
			enqueueMessage({
				chatId: msg.chatId,
				content: `Default agent set to @${agentName}.`,
				dedupKey: `${msg.id}:default`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		// Try loading from disk
		try {
			const def = await loadAgentDefinition(
				`${settings.vault.agentsDir}/${agentName}.md`,
			);
			agentRegistry.set(def.name, def);
			setDefaultAgent(msg.chatId, agentName);
			await updateDefaultAgent(agentName);
			enqueueMessage({
				chatId: msg.chatId,
				content: `Default agent set to @${agentName}.`,
				dedupKey: `${msg.id}:default`,
				label: settings.whatsapp.systemLabel,
			});
		} catch {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Unknown agent: "${agentName}". Check your agent files.`,
				dedupKey: `${msg.id}:default-error`,
				label: settings.whatsapp.systemLabel,
			});
		}
	},
};
