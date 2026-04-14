import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type ModelTier, modelTiers, settings } from "@/config";
import { log } from "@/logger";

export const AgentFrontmatterSchema = z.object({
	name: z.string().min(1),
	aliases: z.array(z.string()).default([]),
	modelTier: z.enum(modelTiers).transform((v) => v as ModelTier),
	tools: z.array(z.string()).default([]),
	toolsets: z.array(z.string()).default([]),
	providerTools: z.array(z.string()).default([]),
	skills: z.array(z.string()).default([]),
	schedule: z.string().optional(),
	persistent: z.boolean().default(false),
	vaultScope: z.string().optional(),
	conversationLimit: z.number().optional(),
	showToolsInContext: z.boolean().default(true),
	provider: z.string().optional(),
	// Direct override fields — agent-level defaults
	forceVoice: z.boolean().optional(),
	suppressVoice: z.boolean().optional(),
	skipHistory: z.boolean().optional(),
	autoAccept: z.boolean().optional(),
	ghost: z.boolean().optional(),
	temperaturePreset: z.enum(["cold", "hot"]).optional(),
	topPPreset: z.enum(["creative", "rigid"]).optional(),
	toolChoice: z.enum(["none", "required"]).optional(),
	reasoningEffort: z.enum(["low", "high"]).optional(),
	fast: z.boolean().optional(),
});

export type AgentDefinition = z.infer<typeof AgentFrontmatterSchema> & {
	/** Absolute path to the .md file — used for hot-reload */
	promptPath: string;
};

/**
 * Load an AgentDefinition from its .md file (parses YAML frontmatter).
 * Called at startup and on hot-reload.
 */
export async function loadAgentDefinition(
	promptPath: string,
): Promise<AgentDefinition> {
	const raw = await Bun.file(promptPath).text();

	const match = raw.match(/^---\n([\s\S]*?)\n---/);
	if (!match) throw new Error(`No YAML frontmatter found in: ${promptPath}`);

	const rawFront = parseYaml(match[1] ?? "");
	const front = AgentFrontmatterSchema.parse(rawFront);

	return { ...front, promptPath };
}

/**
 * Registry of all loaded agents. Populated at startup by scanning /src/agents/*.md.
 */
export const agentRegistry = new Map<string, AgentDefinition>();

/**
 * Scan a directory for *.md agent definition files and load them into agentRegistry.
 * Call once at startup from index.ts.
 */
export async function loadAgents(agentsDir: string): Promise<void> {
	const glob = new Bun.Glob("*.md");
	for await (const file of glob.scan({ cwd: agentsDir })) {
		try {
			const def = await loadAgentDefinition(`${agentsDir}/${file}`);
			agentRegistry.set(def.name, def);
			for (const alias of def.aliases) {
				const existing = agentRegistry.get(alias);
				if (existing && existing.name !== def.name) {
					log.warn(
						`[agent] alias "${alias}" collides between @${def.name} and @${existing.name}, skipping`,
					);
					continue;
				}
				agentRegistry.set(alias, def);
			}
		} catch (err) {
			log.error(`[agent] failed to load agent: ${file}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

// ─── Default agent per chat (inlined from core/defaults.ts) ──────────────────

const defaultOverrides = new Map<string, string>();

export function getDefaultAgent(chatId: string): string {
	return defaultOverrides.get(chatId) ?? settings.defaultAgent;
}

export function setDefaultAgent(chatId: string, agent: string | null): void {
	if (agent === null) defaultOverrides.delete(chatId);
	else defaultOverrides.set(chatId, agent);
}

export function _resetDefaultsForTest(): void {
	defaultOverrides.clear();
}
