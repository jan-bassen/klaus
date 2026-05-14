import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";
import {
	type AgentDefinition,
	agentRegistry,
	loadAgentDefinition,
} from "../../pipeline/agents.ts";
import { loadOverrides } from "../../pipeline/overrides.ts";
import { invalidateTemplate } from "../../pipeline/prompts.ts";
import { parseSkillMeta, skillRegistry } from "../../primitives/tools/skill.ts";
import { loadSettingsFromDisk, settings } from "../config.ts";
import { log } from "../logger.ts";
import { readText } from "../runtime.ts";
import { addSchedule, removeSchedule } from "../store/schedules.ts";
import { enqueueMessage } from "../whatsapp/send.ts";

const watchers: FSWatcher[] = [];
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function debounce(key: string, fn: () => void): void {
	const existing = debounceTimers.get(key);
	if (existing) clearTimeout(existing);
	debounceTimers.set(
		key,
		setTimeout(() => {
			debounceTimers.delete(key);
			fn();
		}, settings.vault.watcherDebounce),
	);
}

/**
 * Look up an agent by its prompt-file path, returning only the canonical
 * registry entry — alias entries share the same `def` and would otherwise
 * leak through, leaving the canonical key behind on rename cleanup.
 */
function findAgentByPath(promptPath: string): { name: string } | undefined {
	for (const [name, def] of agentRegistry) {
		if (def.promptPath === promptPath && def.name === name) return { name };
	}
	return undefined;
}

function frontmatterScheduleId(agentName: string): string {
	return `frontmatter:${agentName}`;
}

type StaticPersistence = Extract<
	NonNullable<AgentDefinition["persistence"]>,
	{ mode: "static" }
>;

interface AgentChange {
	old?: { name: string };
	oldDef?: AgentDefinition;
	newDef: AgentDefinition;
}

function deleteAgentAliases(def: AgentDefinition): void {
	for (const alias of def.aliases) agentRegistry.delete(alias);
}

async function removeAgentByPath(promptPath: string): Promise<void> {
	const old = findAgentByPath(promptPath);
	if (!old) return;

	const oldDef = agentRegistry.get(old.name);
	agentRegistry.delete(old.name);
	if (oldDef) deleteAgentAliases(oldDef);
	await removeSchedule(frontmatterScheduleId(old.name));
	log.info(`[watcher] agent removed: @${old.name}`);
}

function replaceAgentDefinition(newDef: AgentDefinition): AgentChange {
	const old = findAgentByPath(newDef.promptPath);
	const oldDef = old ? agentRegistry.get(old.name) : undefined;

	if (oldDef) deleteAgentAliases(oldDef);
	if (old && old.name !== newDef.name) {
		agentRegistry.delete(old.name);
		log.info(`[watcher] agent renamed: @${old.name} -> @${newDef.name}`);
	}

	agentRegistry.set(newDef.name, newDef);
	for (const alias of newDef.aliases) agentRegistry.set(alias, newDef);

	return {
		newDef,
		...(old ? { old } : {}),
		...(oldDef ? { oldDef } : {}),
	};
}

function staticPersistence(
	def: AgentDefinition | undefined,
): StaticPersistence | null {
	return def?.persistence?.mode === "static" ? def.persistence : null;
}

function staticScheduleChanged(change: AgentChange): boolean {
	const oldStatic = staticPersistence(change.oldDef);
	const newStatic = staticPersistence(change.newDef);
	const nameChanged =
		change.old !== undefined && change.old.name !== change.newDef.name;

	return (
		nameChanged ||
		oldStatic?.schedule !== newStatic?.schedule ||
		oldStatic?.prompt !== newStatic?.prompt ||
		JSON.stringify(oldStatic?.overrides ?? []) !==
			JSON.stringify(newStatic?.overrides ?? [])
	);
}

async function syncFrontmatterSchedule(change: AgentChange): Promise<void> {
	if (!staticScheduleChanged(change)) return;

	const oldName = change.old?.name;
	const newName = change.newDef.name;
	const removedOld = oldName
		? await removeSchedule(frontmatterScheduleId(oldName))
		: false;
	const removedNew =
		oldName !== newName
			? await removeSchedule(frontmatterScheduleId(newName))
			: false;
	if (removedOld || removedNew) {
		log.info(`[watcher] schedule removed for @${oldName ?? newName}`);
	}

	const nextStatic = staticPersistence(change.newDef);
	if (!nextStatic) return;

	await addSchedule({
		id: frontmatterScheduleId(newName),
		agentName: newName,
		pattern: nextStatic.schedule,
		chatId: "system",
		objective: nextStatic.prompt,
		...(nextStatic.overrides.length > 0
			? { overrides: nextStatic.overrides }
			: {}),
		label: `${newName} (frontmatter)`,
		createdBy: "scheduler",
		createdAt: new Date().toISOString(),
	});
	log.info(
		`[watcher] schedule registered for @${newName}: ${nextStatic.schedule}`,
	);
}

export async function handleAgentChange(
	agentsDir: string,
	filename: string,
): Promise<void> {
	const promptPath = `${agentsDir}/${filename}`;
	const exists = existsSync(promptPath);

	if (!exists) {
		await removeAgentByPath(promptPath);
		return;
	}

	try {
		const newDef = await loadAgentDefinition(promptPath);
		await syncFrontmatterSchedule(replaceAgentDefinition(newDef));
		log.info(`[watcher] agent reloaded: @${newDef.name}`);
	} catch (err) {
		log.warn(`[watcher] failed to reload agent: ${filename}`, {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function handleSkillChange(
	skillsDir: string,
	filename: string,
): Promise<void> {
	const filePath = `${skillsDir}/${filename}`;
	const name = filename.replace(/\.md$/, "");
	const exists = existsSync(filePath);

	if (!exists) {
		skillRegistry.delete(name);
		log.info(`[watcher] skill removed: ${name}`);
		return;
	}

	try {
		const raw = await readText(filePath);

		skillRegistry.set(name, parseSkillMeta(name, raw));
		log.info(`[watcher] skill reloaded: ${name}`);
	} catch (err) {
		log.warn(`[watcher] failed to reload skill: ${filename}`, {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export function startWatching(agentsDir: string, skillsDir: string): void {
	const agentWatcher = watch(agentsDir, (_event, filename) => {
		if (!filename?.endsWith(".md")) return;
		debounce(`agent:${filename}`, () => {
			handleAgentChange(agentsDir, filename).catch((err) =>
				log.error("[watcher] unhandled error in agent handler", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		});
	});
	watchers.push(agentWatcher);

	const skillWatcher = watch(skillsDir, (_event, filename) => {
		if (!filename?.endsWith(".md")) return;
		debounce(`skill:${filename}`, () => {
			handleSkillChange(skillsDir, filename).catch((err) =>
				log.error("[watcher] unhandled error in skill handler", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		});
	});
	watchers.push(skillWatcher);

	// Watch Klaus/ internal dir for overrides.yml + settings.yml changes.
	const internalDir = settings.vault.internalPath;
	if (existsSync(internalDir)) {
		const internalWatcher = watch(internalDir, (_event, filename) => {
			if (filename === "overrides.yml") {
				debounce("overrides", () => {
					loadOverrides().catch((err) =>
						log.error("[watcher] failed to reload overrides.yml", {
							error: err instanceof Error ? err.message : String(err),
						}),
					);
				});
				return;
			}
			if (filename === "settings.yml") {
				debounce("settings", () => {
					loadSettingsFromDisk()
						.then((r) => {
							if (!r.ok) {
								log.warn(
									"[watcher] settings reload failed, keeping last valid config",
								);
								warnSettingsInvalid(r.error);
							}
						})
						.catch((err) =>
							log.error("[watcher] settings reload threw", {
								error: err instanceof Error ? err.message : String(err),
							}),
						);
				});
			}
		});
		watchers.push(internalWatcher);
	}

	// Watch Klaus/templates/ for prompt-template edits — invalidate the cache so
	// the next render re-reads from disk.
	const templatesDir = settings.vault.templatesDir;
	if (existsSync(templatesDir)) {
		const templatesWatcher = watch(templatesDir, (_event, filename) => {
			if (!filename?.endsWith(".md")) return;
			debounce(`template:${filename}`, () => {
				const name = filename.replace(/\.md$/, "");
				invalidateTemplate(name);
				log.info(`[watcher] template invalidated: ${name}`);
			});
		});
		watchers.push(templatesWatcher);
	}

	log.info("[watcher] watching for changes");
}

export function stopWatching(): void {
	for (const w of watchers) w.close();
	watchers.length = 0;
	for (const timer of debounceTimers.values()) clearTimeout(timer);
	debounceTimers.clear();
}

/** Surface settings.yml validation errors via WhatsApp so the user sees them. */
function warnSettingsInvalid(error: string): void {
	const chatId = settings.allowedChat;
	if (!chatId) return;
	enqueueMessage({
		chatId,
		content: `*Settings warning*: settings.yml has validation errors. Keeping last valid config.\n\n${error}`,
		dedupKey: `settings-invalid:${Date.now()}`,
		label: settings.whatsapp.systemLabel,
	});
}
