import type { Command } from "@/commands";
import { registry } from "@/commands";
import { agentRegistry } from "@/core/agent";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

const FLAG_DESCRIPTIONS: Record<string, string> = {
	verbose: "verbose response",
	concise: "concise response",
	voice: "reply as a voice note",
	de: "respond in German",
	en: "respond in English",
	formal: "use formal tone",
	test: "mark as a test message",
};

function buildCommandsSection(): string {
	const lines = registry
		.getAll()
		.map((cmd) => `• /${cmd.name} — ${cmd.description}`);
	return `*Commands*\n${lines.join("\n")}`;
}

function buildAgentsSection(): string {
	const lines = [...agentRegistry.values()].map((agent) => {
		const parts: string[] = [];
		if (agent.tools.length > 0) parts.push(`tools: ${agent.tools.join(", ")}`);
		if (agent.toolsets && agent.toolsets.length > 0)
			parts.push(`toolsets: ${agent.toolsets.join(", ")}`);
		const detail = parts.length > 0 ? ` — ${parts.join(" | ")}` : "";
		return `• @${agent.name}${detail}`;
	});
	return `*Agents*\n${lines.join("\n")}`;
}

function buildFlagsSection(): string {
	const lines = Object.entries(FLAG_DESCRIPTIONS).map(
		([flag, desc]) => `• !${flag} — ${desc}`,
	);
	return `*Flags*\n${lines.join("\n")}`;
}

export const helpCommand: Command = {
	name: "help",
	description: "Show available commands, agents, and flags",
	execute(msg: InboundMessage, args: string[]): Promise<void> {
		const section = args[0]?.toLowerCase();

		let content: string;
		if (section === "commands") {
			content = buildCommandsSection();
		} else if (section === "agents") {
			content = buildAgentsSection();
		} else if (section === "flags") {
			content = buildFlagsSection();
		} else {
			content = [
				buildCommandsSection(),
				buildAgentsSection(),
				buildFlagsSection(),
			].join("\n\n");
		}

		enqueueMessage({
			chatId: msg.chatId,
			content,
			dedupKey: `${msg.id}:help`,
		});

		return Promise.resolve();
	},
};
