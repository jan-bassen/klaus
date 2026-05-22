import { settings, updateDefaultAgent } from "../../infra/config.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import {
	agentRegistry,
	loadAgentDefinition,
	setDefaultAgent,
} from "../../pipeline/agents.ts";
import type { Command } from "./index.ts";

function send(msg: InboundMessage, content: string, suffix: string): void {
	enqueueMessage({
		chatId: msg.chatId,
		content,
		dedupKey: `${msg.id}:${suffix}`,
		label: settings.whatsapp.systemLabel,
	});
}

async function setDefault(
	msg: InboundMessage,
	agentName: string,
): Promise<void> {
	setDefaultAgent(msg.chatId, agentName);
	await updateDefaultAgent(agentName);
	send(msg, `Default agent set to @${agentName}.`, "default");
}

export const defaultCommand: Command = {
	name: "default",
	aliases: ["d"],
	params: [{ name: "agent" }],
	description: "Change the default agent",
	async execute(msg: InboundMessage, args: string[]): Promise<void> {
		const agentName = args[0];

		if (!agentName) {
			send(
				msg,
				"Provide a name! Usage: /default <agent_name>",
				"default-usage",
			);
			return;
		}

		if (agentRegistry.get(agentName)) {
			await setDefault(msg, agentName);
			return;
		}

		// Registry miss — try loading the agent from disk
		try {
			const def = await loadAgentDefinition(
				`${settings.vault.agentsDir}/${agentName}.md`,
			);
			agentRegistry.set(def.name, def);
			await setDefault(msg, agentName);
		} catch {
			send(
				msg,
				`Unknown agent: "${agentName}". Check your agent files.`,
				"default-error",
			);
		}
	},
};
