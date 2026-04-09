import type { Command } from "@/commands";
import { agentRegistry } from "@/core/agent";
import { getDefaultAgent } from "@/core/defaults";
import { setFrontmatterField } from "@/core/frontmatter";
import { getProviderNames, resolveProvider } from "@/settings";
import type { AgentDefinition, InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

type LlmTier = AgentDefinition["modelTier"];

const VALID_TIERS: Set<string> = new Set(["small", "medium", "large"]);

export const modelCommand: Command = {
	name: "model",
	aliases: ["m"],
	description:
		"Show or switch the default agent's model tier, or switch provider for this chat",
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
			const providerName = def.provider ?? getProviderNames()[0];
			const providerCfg = resolveProvider(providerName);
			const modelId = providerCfg[def.modelTier];
			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} model: *${modelId}* (tier: ${def.modelTier}, provider: ${providerName})`,
				dedupKey: `${msg.id}:model`,
			});
			return;
		}

		const input = args[0].toLowerCase();

		// Check if it's a provider name
		const providerNames = getProviderNames();
		if (providerNames.includes(input)) {
			try {
				const raw = await Bun.file(def.promptPath).text();
				const updated = setFrontmatterField(raw, "provider", input);
				await Bun.write(def.promptPath, updated);
				def.provider = input;

				const providerCfg = resolveProvider(input);
				const modelId = providerCfg[def.modelTier];
				enqueueMessage({
					chatId: msg.chatId,
					content: `Switched to *${input}* provider. @${agentName}: *${modelId}* (tier: ${def.modelTier})`,
					dedupKey: `${msg.id}:model`,
				});
			} catch (err) {
				enqueueMessage({
					chatId: msg.chatId,
					content: `Failed to update provider: ${err instanceof Error ? err.message : String(err)}`,
					dedupKey: `${msg.id}:model-error`,
				});
			}
			return;
		}

		if (!VALID_TIERS.has(input)) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Unknown tier or provider. Tiers: small, medium, large. Providers: ${providerNames.join(", ")}`,
				dedupKey: `${msg.id}:model-unknown`,
			});
			return;
		}

		const tier = input as LlmTier;

		if (def.modelTier === tier) {
			const providerCfg = resolveProvider(def.provider);
			enqueueMessage({
				chatId: msg.chatId,
				content: `Already using tier "${tier}" (${providerCfg[tier]}).`,
				dedupKey: `${msg.id}:model-noop`,
			});
			return;
		}

		// Read and rewrite frontmatter
		try {
			const raw = await Bun.file(def.promptPath).text();
			const updated = setFrontmatterField(raw, "modelTier", tier);
			await Bun.write(def.promptPath, updated);

			// Update registry immediately (watcher will also reload, but this is instant)
			def.modelTier = tier;

			const providerCfg = resolveProvider(def.provider);
			const modelId = providerCfg[tier];
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
