import { type ModelTier, settings } from "../../infra/config.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import { agentRegistry, getDefaultAgent } from "../../pipeline/agents.ts";
import { overrideRegistry } from "../../pipeline/overrides.ts";
import { getVariables } from "../variables/index.ts";
import type { Command } from "./index.ts";
import { registry } from "./index.ts";

const TIERS: ModelTier[] = ["small", "medium", "large"];

function buildCommandsSection(): string {
	const lines = registry.getAll().map((cmd) => {
		const aliasStr = cmd.aliases?.length
			? ` (${cmd.aliases.map((a) => `/${a}`).join(", ")})`
			: "";
		return `• /${cmd.name}${aliasStr} — ${cmd.description}`;
	});
	return `*Commands*\n${lines.join("\n")}`;
}

function buildAgentsSection(): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const agent of agentRegistry.values()) {
		if (seen.has(agent.name)) continue;
		seen.add(agent.name);
		const aliasStr = agent.aliases.length
			? ` (${agent.aliases.map((a) => `@${a}`).join(", ")})`
			: "";
		const parts: string[] = [];
		if (agent.tools.length > 0) parts.push(`tools: ${agent.tools.join(", ")}`);
		if (agent.toolsets && agent.toolsets.length > 0)
			parts.push(`toolsets: ${agent.toolsets.join(", ")}`);
		const detail = parts.length > 0 ? ` — ${parts.join(" | ")}` : "";
		lines.push(`• @${agent.name}${aliasStr}${detail}`);
	}
	return `*Agents*\n${lines.join("\n")}`;
}

function buildoverridesSection(): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const ow of overrideRegistry.values()) {
		if (seen.has(ow.name)) continue;
		seen.add(ow.name);
		const aliasStr = ow.aliases?.length
			? ` (${ow.aliases.map((a) => `!${a}`).join(", ")})`
			: "";
		lines.push(`• !${ow.name}${aliasStr} — ${ow.description}`);
	}
	return `*overrides*\n${lines.join("\n")}`;
}

function buildVarsSection(): string {
	const vars = getVariables().filter((v) => !v.hidden);

	const lines: string[] = [];
	for (const v of vars) {
		const desc = v.description ? ` — ${v.description}` : "";
		lines.push(`• ${v.key}${desc}`);
	}

	lines.push(
		"",
		"_Use {{var.path}} in prompts and $var.path in messages. Truncate long values with {{trunc value 5000}}._",
	);
	return `*Variables*\n${lines.join("\n")}`;
}

function buildModelsSection(msg: InboundMessage): string {
	const agentName = getDefaultAgent(msg.chatId);
	const def = agentRegistry.get(agentName);
	const currentProvider = def?.settings.provider ?? settings.defaultProvider;
	const currentTier =
		def?.settings.modelTier ?? settings.agentDefaults.modelTier;

	const lines: string[] = [];
	for (const [name, p] of Object.entries(settings.providers)) {
		const ep = settings.endpoints[p.endpoint];
		const via = ep ? ` via ${p.endpoint}` : ` via ?${p.endpoint}`;
		lines.push(`*${name}*${via}`);
		for (const tier of TIERS) {
			const marker =
				name === currentProvider && tier === currentTier ? " ← current" : "";
			lines.push(`  ${tier}: ${p[tier]}${marker}`);
		}
	}
	return `*Models*\n${lines.join("\n")}`;
}

function buildVaultSection(): string {
	const lines: string[] = [];

	for (const folder of settings.vault.folders) {
		const name = folder.path || "(root)";
		lines.push(`• ${name} — ${folder.default}`);
	}

	const internal = settings.vault.internalPermission;
	lines.push(`• ${settings.vault.internal}/ — ${internal.default}`);

	return `*Vault*\n${lines.join("\n")}`;
}

function buildSections(msg: InboundMessage): Record<string, string> {
	return {
		commands: buildCommandsSection(),
		agents: buildAgentsSection(),
		overrides: buildoverridesSection(),
		vars: buildVarsSection(),
		models: buildModelsSection(msg),
		vault: buildVaultSection(),
	};
}

export const helpCommand: Command = {
	name: "help",
	aliases: ["?"],
	description: "Show commands, agents, overrides, vars, models, and vault",
	execute(msg: InboundMessage, args: string[]): Promise<void> {
		const section = args[0]?.toLowerCase();
		const sections = buildSections(msg);
		const content =
			section && sections[section]
				? sections[section]
				: Object.values(sections).join("\n\n");

		enqueueMessage({
			chatId: msg.chatId,
			content,
			dedupKey: `${msg.id}:help`,
			label: settings.whatsapp.systemLabel,
		});

		return Promise.resolve();
	},
};
