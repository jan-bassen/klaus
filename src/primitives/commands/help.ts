import { settings } from "../../infra/config.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import { agentRegistry, getDefaultAgent } from "../../pipeline/agents.ts";
import { overrideRegistry } from "../../pipeline/overrides.ts";
import type { Command } from "./index.ts";
import { formatParams, registry } from "./index.ts";

function entry(
	header: string,
	description: string | undefined,
): string {
	return description ? `${header}\n_${description}_` : header;
}

function aliasSuffix(aliases: string[] | undefined): string {
	return aliases?.length ? ` [${aliases.join(", ")}]` : "";
}

function section(title: string, lines: string[]): string {
	return `*${title}*\n\n${lines.join("\n")}`;
}

function buildCommandsSection(): string {
	const lines = registry.getAll().map((cmd) => {
		const params = formatParams(cmd.params);
		const header = `*/${cmd.name}*${aliasSuffix(cmd.aliases)}${params ? ` ${params}` : ""}`;
		return entry(header, cmd.description);
	});
	return section("Commands", lines);
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
		lines.push(entry(`*!${ow.name}*${aliasSuffix(ow.aliases)}`, ow.description));
	}
	return section("Overrides", lines);
}

function buildProvidersSection(msg: InboundMessage): string {
	const agentName = getDefaultAgent(msg.chatId);
	const def = agentRegistry.get(agentName);
	const current = def?.settings.provider ?? settings.defaultProvider;

	const lines: string[] = [];
	for (const [name, p] of Object.entries(settings.providers)) {
		const marker = name === current ? " ← current" : "";
		lines.push(`*${name}*${marker}\nvia ${p.endpoint}`);
	}
	return section("Providers", lines);
}

function buildSections(msg: InboundMessage): Record<string, string> {
	return {
		commands: buildCommandsSection(),
		agents: buildAgentsSection(),
		overrides: buildOverridesSection(),
		providers: buildProvidersSection(msg),
	};
}

export const helpCommand: Command = {
	name: "help",
	aliases: ["?"],
	params: [{ name: "section" }],
	description: "Show commands, agents, overrides, providers",
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
