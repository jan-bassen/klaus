import { type ModelTier, settings } from "@/infra/config";
import { updateFrontmatter } from "@/infra/vault/markdown";
import type { InboundMessage } from "@/infra/whatsapp/receive";
import { enqueueMessage } from "@/infra/whatsapp/send";
import {
	type AgentDefinition,
	agentRegistry,
	getDefaultAgent,
} from "@/pipeline/agents";
import type { Command } from "@/primitives/commands";

const VALID_TIERS = new Set<ModelTier>(["small", "medium", "large"]);

interface CurrentModel {
	def: AgentDefinition;
	provider: string;
	tier: ModelTier;
	modelId: string | undefined;
}

function resolveCurrent(msg: InboundMessage): CurrentModel | string {
	const agentName = getDefaultAgent(msg.chatId);
	const def = agentRegistry.get(agentName);
	if (!def) return `Default agent "${agentName}" not found in registry.`;

	const provider = def.settings.provider ?? settings.defaultProvider;
	const tier: ModelTier =
		def.settings.modelTier ?? settings.agentDefaults.modelTier;
	const modelId = settings.providers[provider]?.[tier];
	return { def, provider, tier, modelId };
}

async function writeFrontmatter(
	def: AgentDefinition,
	patch: { provider?: string; modelTier?: ModelTier },
): Promise<void> {
	const raw = await Bun.file(def.promptPath).text();
	const updated = updateFrontmatter(raw, (fm) => {
		const s = (fm.settings as Record<string, unknown>) ?? {};
		if (patch.provider !== undefined) s.provider = patch.provider;
		if (patch.modelTier !== undefined) s.modelTier = patch.modelTier;
		fm.settings = s;
	});
	await Bun.write(def.promptPath, updated);
	if (patch.provider !== undefined) def.settings.provider = patch.provider;
	if (patch.modelTier !== undefined) def.settings.modelTier = patch.modelTier;
}

function send(msg: InboundMessage, content: string, suffix: string): void {
	enqueueMessage({
		chatId: msg.chatId,
		content,
		dedupKey: `${msg.id}:${suffix}`,
		label: settings.whatsapp.systemLabel,
	});
}

export const modelCommand: Command = {
	name: "model",
	aliases: ["m"],
	description:
		"Show or switch the default agent's model tier (small|medium|large)",
	async execute(msg: InboundMessage, args: string[]): Promise<void> {
		const cur = resolveCurrent(msg);
		if (typeof cur === "string") return send(msg, cur, "model-error");

		if (args.length === 0) {
			const id = cur.modelId ?? "(unknown)";
			return send(
				msg,
				`@${cur.def.name}: *${id}* (${cur.provider} / ${cur.tier})`,
				"model",
			);
		}

		const tier = args[0]?.toLowerCase() as ModelTier;
		if (!VALID_TIERS.has(tier)) {
			return send(
				msg,
				`Unknown tier "${args[0]}". Tiers: small, medium, large.`,
				"model-unknown",
			);
		}

		if (tier === cur.tier) {
			return send(
				msg,
				`Already on tier "${tier}" (${cur.modelId}).`,
				"model-noop",
			);
		}

		try {
			await writeFrontmatter(cur.def, { modelTier: tier });
			const id = settings.providers[cur.provider]?.[tier];
			send(
				msg,
				`@${cur.def.name} → *${id}* (${cur.provider} / ${tier}).`,
				"model",
			);
		} catch (err) {
			send(
				msg,
				`Failed to update tier: ${err instanceof Error ? err.message : String(err)}`,
				"model-error",
			);
		}
	},
};

export const providerCommand: Command = {
	name: "provider",
	aliases: ["p"],
	description: "Show or switch the default agent's provider",
	async execute(msg: InboundMessage, args: string[]): Promise<void> {
		const cur = resolveCurrent(msg);
		if (typeof cur === "string") return send(msg, cur, "provider-error");

		if (args.length === 0) {
			const id = cur.modelId ?? "(unknown)";
			return send(
				msg,
				`@${cur.def.name}: *${cur.provider}* (${cur.tier} → ${id})`,
				"provider",
			);
		}

		const next = args[0]?.toLowerCase() ?? "";
		if (!settings.providers[next]) {
			return send(
				msg,
				`Unknown provider "${args[0]}". Providers: ${Object.keys(settings.providers).join(", ")}.`,
				"provider-unknown",
			);
		}

		if (next === cur.provider) {
			return send(
				msg,
				`Already on provider "${next}" (${cur.modelId}).`,
				"provider-noop",
			);
		}

		try {
			await writeFrontmatter(cur.def, { provider: next });
			const id = settings.providers[next]?.[cur.tier];
			send(
				msg,
				`@${cur.def.name} → *${id}* (${next} / ${cur.tier}).`,
				"provider",
			);
		} catch (err) {
			send(
				msg,
				`Failed to update provider: ${err instanceof Error ? err.message : String(err)}`,
				"provider-error",
			);
		}
	},
};
