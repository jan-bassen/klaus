import type { Command } from "@/commands";
import { registry } from "@/commands";
import { agentRegistry } from "@/core/agent";
import { getContextVariables } from "@/core/assemble";
import { flagRegistry } from "@/core/flags";
import { settings } from "@/settings";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

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
	const lines = [...flagRegistry.values()].map(
		({ name, description }) => `• !${name} — ${description}`,
	);
	return `*Flags*\n${lines.join("\n")}`;
}

function buildVarsSection(): string {
	const vars = getContextVariables().filter(
		(v) => v.name !== "dispatch_context",
	);

	const lines: string[] = [];
	for (const v of vars) {
		const desc = v.description ? ` — ${v.description}` : "";
		let line = `• $${v.name}${desc}`;
		if (v.params) {
			const paramStr = Object.entries(v.params)
				.map(([k, d]) => `${k}: ${d}`)
				.join(", ");
			line += `\n  params: ${paramStr}`;
		}
		lines.push(line);
	}

	lines.push("", "_$var in messages, {{var}} in prompts_");
	return `*Variables*\n${lines.join("\n")}`;
}

function buildVaultSection(): string {
	const lines: string[] = [];

	for (const folder of settings.vault.folders) {
		const name = folder.path || "(root)";
		const perm = folder.request
			? `${folder.default} (request: ${folder.request})`
			: folder.default;
		lines.push(`• ${name} — ${perm}`);
	}

	const internal = settings.vault.internalPermission;
	const internalPerm = internal.request
		? `${internal.default} (request: ${internal.request})`
		: internal.default;
	lines.push(`• ${settings.vault.internal}/ — ${internalPerm}`);

	return `*Vault*\n${lines.join("\n")}`;
}

export const helpCommand: Command = {
	name: "help",
	description: "Show commands, agents, flags, vars, and vault",
	execute(msg: InboundMessage, args: string[]): Promise<void> {
		const section = args[0]?.toLowerCase();

		let content: string;
		if (section === "commands") {
			content = buildCommandsSection();
		} else if (section === "agents") {
			content = buildAgentsSection();
		} else if (section === "flags") {
			content = buildFlagsSection();
		} else if (section === "vars") {
			content = buildVarsSection();
		} else if (section === "vault") {
			content = buildVaultSection();
		} else {
			content = [
				buildCommandsSection(),
				buildAgentsSection(),
				buildFlagsSection(),
				buildVarsSection(),
				buildVaultSection(),
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
