import {
	getProviderNames,
	type ModelTier,
	resolveProvider,
	settings,
} from "@/infra/config";
import { updateFrontmatter } from "@/infra/vault/markdown";
import { enqueueMessage } from "@/infra/whatsapp/send";
import { agentRegistry, getDefaultAgent } from "@/pipeline/agents";
import type { Command } from "@/primitives/commands";
import type { InboundMessage } from "@/infra/whatsapp/receive";

const VALID_TIERS = new Set(["small", "medium", "large"] as const);

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
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		const currentTier: ModelTier =
			def.settings.modelTier ?? settings.agentDefaults.modelTier;

		if (!args[0]) {
			const providerName = def.settings.provider ?? getProviderNames()[0];
			const providerCfg = resolveProvider(providerName);
			const modelId = providerCfg[currentTier];
			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} model: *${modelId}* (tier: ${currentTier}, provider: ${providerName})`,
				dedupKey: `${msg.id}:model`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		const input = args[0].toLowerCase();

		const providerNames = getProviderNames();
		if (providerNames.includes(input)) {
			try {
				const raw = await Bun.file(def.promptPath).text();
				const updated = updateFrontmatter(raw, (fm) => {
					const s = (fm.settings as Record<string, unknown>) ?? {};
					s.provider = input;
					fm.settings = s;
				});
				await Bun.write(def.promptPath, updated);
				def.settings.provider = input;

				const providerCfg = resolveProvider(input);
				const modelId = providerCfg[currentTier];
				enqueueMessage({
					chatId: msg.chatId,
					content: `Switched to *${input}* provider. @${agentName}: *${modelId}* (tier: ${currentTier})`,
					dedupKey: `${msg.id}:model`,
					label: settings.whatsapp.systemLabel,
				});
			} catch (err) {
				enqueueMessage({
					chatId: msg.chatId,
					content: `Failed to update provider: ${err instanceof Error ? err.message : String(err)}`,
					dedupKey: `${msg.id}:model-error`,
					label: settings.whatsapp.systemLabel,
				});
			}
			return;
		}

		if (!VALID_TIERS.has(input as ModelTier)) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Unknown tier or provider. Tiers: small, medium, large. Providers: ${providerNames.join(", ")}`,
				dedupKey: `${msg.id}:model-unknown`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		const tier = input as ModelTier;

		if (currentTier === tier) {
			const providerCfg = resolveProvider(def.settings.provider);
			enqueueMessage({
				chatId: msg.chatId,
				content: `Already using tier "${tier}" (${providerCfg[tier]}).`,
				dedupKey: `${msg.id}:model-noop`,
				label: settings.whatsapp.systemLabel,
			});
			return;
		}

		try {
			const raw = await Bun.file(def.promptPath).text();
			const updated = updateFrontmatter(raw, (fm) => {
				const s = (fm.settings as Record<string, unknown>) ?? {};
				s.modelTier = tier;
				fm.settings = s;
			});
			await Bun.write(def.promptPath, updated);
			def.settings.modelTier = tier;

			const providerCfg = resolveProvider(def.settings.provider);
			const modelId = providerCfg[tier];
			enqueueMessage({
				chatId: msg.chatId,
				content: `@${agentName} switched to *${modelId}* (tier: ${tier}).`,
				dedupKey: `${msg.id}:model`,
				label: settings.whatsapp.systemLabel,
			});
		} catch (err) {
			enqueueMessage({
				chatId: msg.chatId,
				content: `Failed to update model: ${err instanceof Error ? err.message : String(err)}`,
				dedupKey: `${msg.id}:model-error`,
				label: settings.whatsapp.systemLabel,
			});
		}
	},
};
