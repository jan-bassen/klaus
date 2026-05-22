import { settings } from "../../infra/config.ts";
import type { InboundMessage } from "../../infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../infra/whatsapp/send.ts";
import {
	type AgentDefinition,
	agentRegistry,
	getDefaultAgent,
} from "../../pipeline/agents.ts";
import { overrideRegistry } from "../../pipeline/overrides.ts";
import { renderTemplate } from "../../pipeline/templates.ts";
import type { Command } from "./index.ts";
import { formatParams, registry } from "./index.ts";

interface HelpSettings {
	agent: string;
	model?: string;
	voice?: string;
	report?: string;
	history?: string;
}

interface HelpAgent {
	name: string;
	aliases: string;
	tools?: string;
	toolsets?: string;
	model: string;
	history: string;
}

interface HelpEntry {
	name: string;
	aliases: string;
	params?: string;
	description: string;
}

interface HelpTemplateVars extends Record<string, unknown> {
	settings?: HelpSettings;
	agents?: HelpAgent[];
	commands?: HelpEntry[];
	overrides?: HelpEntry[];
}

function aliases(aliases: string[] | undefined): string {
	return aliases?.length ? ` [${aliases.join(", ")}]` : "";
}

function modelLine(def: AgentDefinition): string {
	const provider = def.settings.provider ?? settings.defaultProvider;
	const tier = def.settings.modelTier ?? settings.agentDefaults.modelTier;
	return `${provider} / ${tier}`;
}

function historyLine(def: AgentDefinition): string {
	const limit =
		def.settings.historyLimit ?? settings.agentDefaults.historyLimit;
	const scope =
		def.settings.historyScope ?? settings.agentDefaults.historyScope;
	return `${limit} (${scope} scope)`;
}

function buildSettings(msg: InboundMessage): HelpSettings {
	const agentName = getDefaultAgent(msg.chatId);
	const def = agentRegistry.get(agentName);
	if (!def) {
		return {
			agent: `${agentName} (not loaded)`,
		};
	}

	return {
		agent: def.name,
		model: modelLine(def),
		voice: def.settings.voice,
		report: def.settings.report ? "on" : "off",
		history: historyLine(def),
	};
}

function buildAgents(): HelpAgent[] {
	const seen = new Set<string>();
	const agents: HelpAgent[] = [];
	for (const agent of agentRegistry.values()) {
		if (seen.has(agent.name)) continue;
		seen.add(agent.name);
		agents.push({
			name: agent.name,
			aliases: aliases(agent.aliases),
			...(agent.tools.length > 0 ? { tools: agent.tools.join(", ") } : {}),
			...(agent.toolsets.length > 0
				? { toolsets: agent.toolsets.join(", ") }
				: {}),
			model: modelLine(agent),
			history: historyLine(agent),
		});
	}
	return agents;
}

function buildCommands(): HelpEntry[] {
	return registry.getAll().map((cmd) => {
		const params = formatParams(cmd.params);
		return {
			name: cmd.name,
			aliases: aliases(cmd.aliases),
			...(params ? { params } : {}),
			description: cmd.description,
		};
	});
}

function buildOverrides(): HelpEntry[] {
	const seen = new Set<string>();
	const overrides: HelpEntry[] = [];
	for (const ow of overrideRegistry.values()) {
		if (seen.has(ow.name)) continue;
		seen.add(ow.name);
		overrides.push({
			name: ow.name,
			aliases: aliases(ow.aliases),
			description: ow.description,
		});
	}
	return overrides;
}

function buildVars(
	msg: InboundMessage,
	section: string | undefined,
): HelpTemplateVars {
	const all = !section;
	const vars: HelpTemplateVars = {};
	if (all || section === "settings") vars.settings = buildSettings(msg);
	if (all || section === "agents") vars.agents = buildAgents();
	if (all || section === "commands") vars.commands = buildCommands();
	if (all || section === "overrides") vars.overrides = buildOverrides();
	return vars;
}

export const helpCommand: Command = {
	name: "help",
	aliases: ["?"],
	params: [{ name: "section" }],
	description: "Show settings, agents, overrides, commands",
	execute(msg: InboundMessage, args: string[]): Promise<void> {
		const requested = args[0]?.toLowerCase();
		const section = ["settings", "agents", "commands", "overrides"].includes(
			requested ?? "",
		)
			? requested
			: undefined;
		const content = renderTemplate("help", buildVars(msg, section));

		enqueueMessage({
			chatId: msg.chatId,
			content,
			dedupKey: `${msg.id}:help`,
			label: settings.whatsapp.systemLabel,
		});

		return Promise.resolve();
	},
};
