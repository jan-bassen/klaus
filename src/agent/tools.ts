import { type StepResult, type ToolSet, tool } from "ai";
import { resolveProvider, settings } from "@/config";
import { log } from "@/logger";
import { generateMetaTool, toolRegistry, toolsetRegistry } from "@/tools";
import { getProviderTool } from "@/tools/provider";
import { buildSkillTool, skillRegistry } from "@/tools/skill";
import type { AgentDefinition, ToolDefinition, TurnContext } from "@/types";
import { awaitConfirmation } from "@/whatsapp/confirm";

export interface AssembledTools {
	allTools: ToolSet;
	initialActive: string[];
	prepareStep: (steps: StepResult<ToolSet>[]) => string[];
}

/**
 * Build the full tool set visible to the model plus the initial allowlist.
 *
 * Core tools, provider tools, and toolset meta-tools start active. Actual
 * toolset tools are registered but hidden until the meta-tool (`use_<set>`)
 * is called. Skills attach their own tools lazily via `skill.get`.
 *
 * `prepareStep` inspects prior steps and expands the allowlist accordingly.
 */
export function assembleTools(
	def: AgentDefinition,
	turn: TurnContext,
): AssembledTools {
	// Each tool wraps ToolDefinition.execute and gates on confirmation if required.
	const wrap = (t: ToolDefinition) =>
		tool({
			description: t.description,
			inputSchema: t.inputSchema,
			execute: async (input) => {
				if (t.requiresConfirmation && !turn.config?.autoAccept) {
					if (!turn.message)
						return "Cannot request confirmation — no inbound message context.";
					const result = await awaitConfirmation(
						turn.message,
						`Confirm ${t.name}? React 👍 to proceed.`,
					);
					if (result !== "confirmed") return "Operation cancelled by user.";
				}
				return t.execute(input, turn);
			},
		});

	const allTools: ToolSet = {};
	const initialActive: string[] = [];

	// Core tools — always active
	for (const name of def.tools) {
		const t = toolRegistry.get(name);
		if (!t) {
			log.warn(`[agent] unknown tool: ${name}`);
			continue;
		}
		const sdkName = t.name.replace(/\./g, "_");
		allTools[sdkName] = wrap(t);
		initialActive.push(sdkName);
	}

	// Provider tools — injected directly (no wrapping), always active.
	const providerCfg = resolveProvider(turn.config?.provider);
	for (const name of def.providerTools ?? []) {
		const pt = getProviderTool(name, providerCfg.sdk);
		if (!pt) {
			log.warn(
				`[agent] provider tool "${name}" not available for ${providerCfg.sdk}`,
			);
			continue;
		}
		allTools[name] = pt;
		initialActive.push(name);
	}

	// Toolsets — register meta-tool (active) + all toolset tools (inactive until activated)
	for (const tsName of def.toolsets ?? []) {
		const ts = toolsetRegistry.get(tsName);
		if (!ts) {
			log.warn(`[agent] unknown toolset: ${tsName}`);
			continue;
		}
		const meta = generateMetaTool(ts);
		allTools[meta.name] = wrap(meta);
		initialActive.push(meta.name);
		for (const t of ts.tools) {
			allTools[t.name.replace(/\./g, "_")] = wrap(t);
		}
	}

	// Skills — per-agent scoped tool, registered only when agent declares skills
	if (def.skills?.length) {
		const skillTool = buildSkillTool(def.skills, settings.vault.skillsDir);
		const sdkToolName = skillTool.name.replace(/\./g, "_");
		allTools[sdkToolName] = wrap(skillTool);
		initialActive.push(sdkToolName);

		// Pre-register tools that skills may activate (inactive until skill is loaded)
		for (const sName of def.skills) {
			const meta = skillRegistry.get(sName);
			if (!meta) continue;
			for (const toolName of meta.tools) {
				const t = toolRegistry.get(toolName);
				if (!t) {
					log.warn(`[agent] unknown tool "${toolName}" in skill ${sName}`);
					continue;
				}
				const n = t.name.replace(/\./g, "_");
				if (!allTools[n]) allTools[n] = wrap(t);
			}
			for (const tsName of meta.toolsets) {
				const ts = toolsetRegistry.get(tsName);
				if (!ts) {
					log.warn(`[agent] unknown toolset "${tsName}" in skill ${sName}`);
					continue;
				}
				for (const t of ts.tools) {
					const n = t.name.replace(/\./g, "_");
					if (!allTools[n]) allTools[n] = wrap(t);
				}
			}
		}
	}

	// Expand activeTools when meta-tools or skill_get are called in previous steps.
	const prepareStep = (steps: StepResult<ToolSet>[]): string[] => {
		const active = new Set(initialActive);
		for (const step of steps) {
			for (const call of step.toolCalls) {
				const name = call.toolName as string;
				if (name.startsWith("use_")) {
					const tsName = name.slice(4); // 'use_files' → 'files'
					const ts = toolsetRegistry.get(tsName);
					if (!ts) continue;
					active.delete(`use_${tsName}`); // replace meta-tool with actual tools
					for (const t of ts.tools) active.add(t.name.replace(/\./g, "_"));
				} else if (name === "skill_get") {
					const sName = (call as unknown as { input?: { name?: string } }).input
						?.name;
					const meta = sName ? skillRegistry.get(sName) : undefined;
					if (!meta) continue;
					for (const toolName of meta.tools) {
						active.add(toolName.replace(/\./g, "_"));
					}
					for (const tsName of meta.toolsets) {
						const ts = toolsetRegistry.get(tsName);
						if (!ts) continue;
						for (const t of ts.tools) active.add(t.name.replace(/\./g, "_"));
					}
				}
			}
		}
		return [...active];
	};

	return { allTools, initialActive, prepareStep };
}
