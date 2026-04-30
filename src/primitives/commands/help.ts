import { settings } from "../../infra/config.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import {
	type AgentDefinition,
	agentRegistry,
	getDefaultAgent,
} from "../../pipeline/agents.ts";
import { overrideRegistry } from "../../pipeline/overrides.ts";
import type { Command } from "./index.ts";
import { formatParams, registry } from "./index.ts";

function entry(header: string, description: string | undefined): string {
	return description ? `${header}\n_${description}_` : header;
}

function aliasSuffix(aliases: string[] | undefined): string {
	return aliases?.length ? ` [${aliases.join(", ")}]` : "";
}

function section(title: string, lines: string[]): string {
	return `*${title}*\n\n${lines.join("\n")}`;
}

function modelLine(def: AgentDefinition): string {
	const provider = def.settings.provider ?? settings.defaultProvider;
	const tier = def.settings.modelTier ?? settings.agentDefaults.modelTier;
	const id = settings.providers[provider]?.[tier] ?? "(unknown)";
	return `${provider} / ${tier} → ${id}`;
}

function historyLine(def: AgentDefinition): string {
	const limit =
		def.settings.historyLimit ?? settings.agentDefaults.historyLimit;
	const scope =
		def.settings.historyScope ?? settings.agentDefaults.historyScope;
	return `${limit} (${scope})`;
}

function buildSettingsSection(msg: InboundMessage): string {
	const agentName = getDefaultAgent(msg.chatId);
	const def = agentRegistry.get(agentName);
	if (!def) return section("Settings", [`agent: *${agentName}* (not loaded)`]);

	const lines = [
		`agent: *@${def.name}*`,
		`model: ${modelLine(def)}`,
		`voice: ${def.settings.voice}`,
		`report: ${def.settings.report ? "on" : "off"}`,
		`history: ${historyLine(def)}`,
	];
	return section("Settings", lines);
}

function agentExtras(def: AgentDefinition): string[] {
	const extras: string[] = [];
	if (def.settings.provider || def.settings.modelTier) {
		extras.push(`model: ${modelLine(def)}`);
	}
	if (def.settings.historyLimit || def.settings.historyScope) {
		extras.push(`history: ${historyLine(def)}`);
	}
	return extras;
}

function buildAgentsSection(): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const agent of agentRegistry.values()) {
		if (seen.has(agent.name)) continue;
		seen.add(agent.name);
		const parts: string[] = [];
		if (agent.tools.length > 0) parts.push(`tools: ${agent.tools.join(", ")}`);
		if (agent.toolsets && agent.toolsets.length > 0)
			parts.push(`toolsets: ${agent.toolsets.join(", ")}`);
		parts.push(...agentExtras(agent));
		lines.push(
			entry(`*@${agent.name}*${aliasSuffix(agent.aliases)}`, parts.join(" | ")),
		);
	}
	return section("Agents", lines);
}

function buildOverridesSection(): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const ow of overrideRegistry.values()) {
		if (seen.has(ow.name)) continue;
		seen.add(ow.name);
		lines.push(
			entry(`*!${ow.name}*${aliasSuffix(ow.aliases)}`, ow.description),
		);
	}
	return section("Overrides", lines);
}

function buildCommandsSection(): string {
	const lines = registry.getAll().map((cmd) => {
		const params = formatParams(cmd.params);
		const header = `*/${cmd.name}*${aliasSuffix(cmd.aliases)}${params ? ` ${params}` : ""}`;
		return entry(header, cmd.description);
	});
	return section("Commands", lines);
}

function buildSections(msg: InboundMessage): Record<string, string> {
	return {
		settings: buildSettingsSection(msg),
		agents: buildAgentsSection(),
		overrides: buildOverridesSection(),
		commands: buildCommandsSection(),
	};
}

export const helpCommand: Command = {
	name: "help",
	aliases: ["?"],
	params: [{ name: "section" }],
	description: "Show settings, agents, overrides, commands",
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
