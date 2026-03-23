import type { Command } from "@/commands";
import { agentRegistry } from "@/core/agent";
import { getDefaultAgent } from "@/core/defaults";
import { settings } from "@/settings";
import type { AgentDefinition, InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

type LlmTier = AgentDefinition["modelTier"];

const VALID_TIERS: Set<string> = new Set(["default", "low", "high"]);

export const modelCommand: Command = {
	name: "model",
	description: "Show or switch the default agent's model tier",
	async execute(msg: InboundMessage, args: string[]): Promise<void> {
		const agentName = getDefaultAgent(msg.chatId);
		const def = agentRegistry.get(agentName);

		if (!def) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Default agent "${agentName}" not found in registry.`,
				dedupKey: `${msg.id}:model-error`,
			});
			return;
		}

		// No args — show current model
		if (!args[0]) {
			const modelId = settings.models[def.modelTier];
			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} model: *${modelId}* (tier: ${def.modelTier})`,
				dedupKey: `${msg.id}:model`,
			});
			return;
		}

		const input = args[0].toLowerCase();

		if (!VALID_TIERS.has(input)) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Unknown tier. Options: default, low, high`,
				dedupKey: `${msg.id}:model-unknown`,
			});
			return;
		}

		const tier = input as LlmTier;

		if (def.modelTier === tier) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Already using tier "${tier}" (${settings.models[tier]}).`,
				dedupKey: `${msg.id}:model-noop`,
			});
			return;
		}

		// Read and rewrite frontmatter
		try {
			const raw = await Bun.file(def.promptPath).text();
			const updated = raw.replace(
				/^(---\n[\s\S]*?)modelTier:\s*\S+([\s\S]*?\n---)/,
				`$1modelTier: ${tier}$2`,
			);

			await Bun.write(def.promptPath, updated);

			// Update registry immediately (watcher will also reload, but this is instant)
			def.modelTier = tier;

			const modelId = settings.models[tier];
			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} switched to *${modelId}* (tier: ${tier}).`,
				dedupKey: `${msg.id}:model`,
			});
		} catch (err) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Failed to update model: ${err instanceof Error ? err.message : String(err)}`,
				dedupKey: `${msg.id}:model-error`,
			});
		}
	},
};
