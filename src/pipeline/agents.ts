/**
 * Agent definitions: parse `.md` frontmatter into `AgentDefinition`, hold the
 * loaded registry, and track the per-chat default agent.
 *
 * The frontmatter shape lives in this file as the `AgentSchema`. Anything
 * downstream that needs settings reads them from `def.settings.*` (always
 * populated — defaults fill in when a settings block is absent).
 */

import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type ModelTier, modelTiers, settings } from "@/infra/config";
import { log } from "@/infra/logger";

// ── Settings ───────────────────────────────────────────────────────────────

/**
 * Per-agent default behavior. Per-message `!overrides` win over these; settings
 * here win over the global `settings.agentDefaults`.
 *
 * `voice/temp/topP/reasoningEffort` use a tri-state (`"on"|"auto"|"off"` etc.)
 * to disambiguate "explicitly default" from "not set" — the resolver in
 * `pipeline/overrides.ts` translates these into the runtime `TurnConfig`.
 */
export const AgentSettingsSchema = z
	.object({
		provider: z.string().optional(),
		modelTier: z.enum(modelTiers).optional(),
		voice: z.enum(["on", "auto", "off"]).default("auto"),
		accept: z.boolean().default(false),
		temp: z.enum(["cold", "default", "hot"]).default("default"),
		topP: z.enum(["creative", "default", "rigid"]).default("default"),
		reasoningEffort: z.enum(["low", "default", "high"]).default("default"),
		stepLimit: z.number().optional(),
		historyLimit: z.number().optional(),
		historyScope: z.enum(["full", "agent"]).optional(),
		/** Render the per-turn `[Used X, Y → replied]` summary in history? */
		showTrace: z.boolean().default(true),
		report: z.enum(["full", "agent", "none"]).default("agent"),
		vault: z
			.record(
				z.string(),
				z.union([
					z.enum(["none", "read", "full"]),
					z
						.object({
							default: z.enum(["none", "read", "full"]),
							confirm: z.enum(["none", "read", "append", "full"]).optional(),
						})
						.strict(),
				]),
			)
			.optional(),
	})
	.transform((s) => ({
		...s,
		modelTier: s.modelTier as ModelTier | undefined,
	}));

export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

// ── Persistence ────────────────────────────────────────────────────────────

/**
 * Static = recurring schedule with a fixed prompt + override set.
 * Dynamic = the agent decides its own next run by calling the `persist` tool.
 */
export const PersistenceSchema = z.discriminatedUnion("mode", [
	z.object({
		mode: z.literal("static"),
		schedule: z.string(),
		prompt: z.string(),
		overrides: z.array(z.string()).default([]),
	}),
	z.object({
		mode: z.literal("dynamic"),
		hint: z.string(),
	}),
]);

export type Persistence = z.infer<typeof PersistenceSchema>;

// ── Agent ──────────────────────────────────────────────────────────────────

export const AgentSchema = z.object({
	name: z.string().min(1),
	aliases: z.array(z.string()).default([]),
	tools: z.array(z.string()).default([]),
	toolsets: z.array(z.string()).default([]),
	providerTools: z.array(z.string()).default([]),
	skills: z.array(z.string()).default([]),
	settings: AgentSettingsSchema.prefault({}),
	persistence: PersistenceSchema.optional(),
});

export type AgentDefinition = z.infer<typeof AgentSchema> & {
	/** Absolute path to the .md file — used for hot-reload. */
	promptPath: string;
};

/** Parses YAML frontmatter from the .md file at `promptPath`. */
export async function loadAgentDefinition(
	promptPath: string,
): Promise<AgentDefinition> {
	const raw = await Bun.file(promptPath).text();

	const match = raw.match(/^---\n([\s\S]*?)\n---/);
	if (!match) throw new Error(`No YAML frontmatter found in: ${promptPath}`);

	const rawFront = parseYaml(match[1] ?? "");
	const front = AgentSchema.parse(rawFront);

	return { ...front, promptPath };
}

/**
 * Registry of all loaded agents — populated at startup by scanning the agents
 * directory, augmented on hot-reload by the file watcher. Indexed by both
 * canonical name and each declared alias.
 */
export const agentRegistry = new Map<string, AgentDefinition>();

/** Scan a directory of `.md` agent files into `agentRegistry`. */
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
						`[agents] alias "${alias}" collides between @${def.name} and @${existing.name}, skipping`,
					);
					continue;
				}
				agentRegistry.set(alias, def);
			}
		} catch (err) {
			log.error(`[agents] failed to load agent: ${file}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

/** Resolve an agent by name, lazy-loading from disk on miss. */
export async function getOrLoadAgent(name: string): Promise<AgentDefinition> {
	const existing = agentRegistry.get(name);
	if (existing) return existing;
	const promptPath = path.join(settings.vault.agentsDir, `${name}.md`);
	const def = await loadAgentDefinition(promptPath);
	agentRegistry.set(def.name, def);
	return def;
}

// ── Default agent per chat ─────────────────────────────────────────────────

const defaultAgentOverrides = new Map<string, string>();

export function getDefaultAgent(chatId: string): string {
	return defaultAgentOverrides.get(chatId) ?? settings.defaultAgent;
}

export function setDefaultAgent(chatId: string, agent: string | null): void {
	if (agent === null) defaultAgentOverrides.delete(chatId);
	else defaultAgentOverrides.set(chatId, agent);
}
