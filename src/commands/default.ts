import path from "node:path";
import {
	agentRegistry,
	loadAgentDefinition,
	setDefaultAgent,
} from "@/agent/definitions";
import type { Command } from "@/commands";
import { settings } from "@/config";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

const AGENTS_DIR = path.join(import.meta.dir, "..", "agents");

export const defaultCommand: Command = {
	name: "default",
	description: "Set the default agent for this chat",
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
				path.join(AGENTS_DIR, `${agentName}.md`),
			);
			agentRegistry.set(def.name, def);
			setDefaultAgent(msg.chatId, agentName);
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
