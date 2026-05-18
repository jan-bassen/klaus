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
import {
	type AgentVaultEntry,
	type ModelTier,
	modelTiers,
	settings,
} from "../infra/config.ts";
import { log } from "../infra/logger.ts";

import { readText, scanFiles } from "../infra/runtime.ts";

// ── Settings ───────────────────────────────────────────────────────────────

/**
 * Per-agent default behavior. Per-message `!overrides` win over these; settings
 * here win over the global `settings.agentDefaults`.
 *
 * `voice/temp/topP/reasoningEffort` use a tri-state (`"on"|"auto"|"off"` etc.)
 * to disambiguate "explicitly default" from "not set" — the resolver in
 * `pipeline/overrides.ts` translates these into the runtime `TurnConfig`.
 */
const AgentSettingsSchema = z
	.object({
		provider: z.string().optional(),
		modelTier: z.enum(modelTiers).optional(),
		voice: z.enum(["on", "auto", "off"]).default("auto"),
		temp: z.enum(["cold", "default", "hot"]).default("default"),
		topP: z.enum(["creative", "default", "rigid"]).default("default"),
		reasoningEffort: z.enum(["low", "default", "high"]).default("default"),
		stepLimit: z.number().optional(),
		historyLimit: z.number().optional(),
		historyScope: z.enum(["full", "agent"]).optional(),
		/** Render the per-turn `[Used X, Y → replied]` summary in history? */
		showTrace: z.boolean().default(true),
		report: z.boolean().default(true),
		vault: z.record(z.string(), z.enum(["none", "read", "full"])).optional(),
	})
	.transform((s) => ({
		...s,
		modelTier: s.modelTier as ModelTier | undefined,
	}));

// ── Persistence + schedules ────────────────────────────────────────────────

const AgentScheduleSchema = z.object({
	pattern: z.string().min(1),
	label: z.string().min(1).optional(),
	overrides: z.array(z.string()).default([]),
});

interface Persistence {
	hint: string;
	overrides: string[];
}

// ── Agent ──────────────────────────────────────────────────────────────────

const VaultAccessPermissionSchema = z.enum(["none", "read", "full"]);

function parseVaultAccess(
	entries: string[],
	ctx: z.RefinementCtx,
): Record<string, AgentVaultEntry> | undefined {
	const out: Record<string, AgentVaultEntry> = {};
	for (const [index, entry] of entries.entries()) {
		const separator = entry.lastIndexOf(":");
		if (separator < 0) {
			ctx.addIssue({
				code: "custom",
				path: ["vaultAccess", index],
				message: 'Expected "path:permission" (permission: none, read, full)',
			});
			continue;
		}

		const key = entry.slice(0, separator).trim();
		const rawPermission = entry.slice(separator + 1).trim();
		const permission = VaultAccessPermissionSchema.safeParse(rawPermission);
		if (!permission.success) {
			ctx.addIssue({
				code: "custom",
				path: ["vaultAccess", index],
				message: 'Expected permission "none", "read", or "full"',
			});
			continue;
		}

		out[key] = permission.data;
	}

	return Object.keys(out).length > 0 ? out : undefined;
}

const AgentFrontmatterSchema = z
	.object({
		name: z.string().min(1),
		aliases: z.array(z.string()).default([]),
		tools: z.array(z.string()).default([]),
		toolsets: z.array(z.string()).default([]),
		providerTools: z.array(z.string()).default([]),
		skills: z.array(z.string()).default([]),
		provider: z.string().optional(),
		modelTier: z.enum(modelTiers).optional(),
		voice: z.enum(["on", "auto", "off"]).default("auto"),
		temp: z.enum(["cold", "default", "hot"]).default("default"),
		topP: z.enum(["creative", "default", "rigid"]).default("default"),
		reasoningEffort: z.enum(["low", "default", "high"]).default("default"),
		stepLimit: z.number().optional(),
		historyLimit: z.number().optional(),
		historyScope: z.enum(["full", "agent"]).optional(),
		showTrace: z.boolean().default(true),
		report: z.boolean().default(true),
		vaultAccess: z.array(z.string()).default([]),
		persist: z.boolean().default(false),
		persistHint: z.string().optional(),
		persistOverrides: z.array(z.string()).default([]),
		schedules: z.array(AgentScheduleSchema).default([]),
	})
	.strict()
	.transform((front, ctx) => {
		let persistence: Persistence | undefined;
		if (front.persist) {
			if (front.persistHint === undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["persistHint"],
					message: "Required when persist is true",
				});
			} else {
				persistence = {
					hint: front.persistHint,
					overrides: front.persistOverrides,
				};
			}
		}

		return {
			name: front.name,
			aliases: front.aliases,
			tools: front.tools,
			toolsets: front.toolsets,
			providerTools: front.providerTools,
			skills: front.skills,
			settings: AgentSettingsSchema.parse({
				provider: front.provider,
				modelTier: front.modelTier,
				voice: front.voice,
				temp: front.temp,
				topP: front.topP,
				reasoningEffort: front.reasoningEffort,
				stepLimit: front.stepLimit,
				historyLimit: front.historyLimit,
				historyScope: front.historyScope,
				showTrace: front.showTrace,
				report: front.report,
				vault: parseVaultAccess(front.vaultAccess, ctx),
			}),
			...(persistence ? { persistence } : {}),
			schedules: front.schedules,
		};
	});

export const AgentSchema = AgentFrontmatterSchema;

export type AgentDefinition = z.infer<typeof AgentSchema> & {
	/** Absolute path to the .md file — used for hot-reload. */
	promptPath: string;
	prompt: {
		system: string;
		message?: string;
	};
};

function parsePromptSections(body: string): AgentDefinition["prompt"] {
	const heading = /^# +(system|message) *$/gim;
	const matches = [...body.matchAll(heading)];
	if (matches.length === 0) return { system: body };

	const sections = new Map<string, string>();
	for (const [index, match] of matches.entries()) {
		const name = match[1]?.toLowerCase();
		if (!name) continue;
		const start = (match.index ?? 0) + match[0].length;
		const end = matches[index + 1]?.index ?? body.length;
		sections.set(name, body.slice(start, end).trim());
	}

	const system = sections.get("system") ?? "";
	const message = sections.get("message");
	return message === undefined ? { system } : { system, message };
}

/** Parses YAML frontmatter from the .md file at `promptPath`. */
export async function loadAgentDefinition(
	promptPath: string,
): Promise<AgentDefinition> {
	const raw = await readText(promptPath);

	const match = raw.match(/^---\n([\s\S]*?)\n---/);
	if (!match) throw new Error(`No YAML frontmatter found in: ${promptPath}`);

	const rawFront = parseYaml(match[1] ?? "");
	const front = AgentSchema.parse(rawFront);
	const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
	const prompt = parsePromptSections(body);
	if (front.schedules.length > 0 && prompt.message === undefined) {
		throw new Error(
			`Agent @${front.name} defines schedules but has no # Message section`,
		);
	}

	return { ...front, promptPath, prompt };
}

/**
 * Registry of all loaded agents — populated at startup by scanning the agents
 * directory, augmented on hot-reload by the file watcher. Indexed by both
 * canonical name and each declared alias.
 */
export const agentRegistry = new Map<string, AgentDefinition>();

/** Scan a directory of `.md` agent files into `agentRegistry`. */
export async function loadAgents(agentsDir: string): Promise<void> {
	for await (const file of scanFiles(agentsDir, "*.md")) {
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
