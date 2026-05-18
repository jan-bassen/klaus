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
import {
	addSchedule,
	getSchedules,
	removeSchedule,
} from "../store/schedules.ts";
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

function frontmatterScheduleId(agentName: string, index: number): string {
	return `frontmatter:${agentName}:${index}`;
}

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
	await removeFrontmatterSchedules(old.name);
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

function frontmatterSchedulesChanged(change: AgentChange): boolean {
	const nameChanged =
		change.old !== undefined && change.old.name !== change.newDef.name;

	return (
		nameChanged ||
		change.oldDef?.prompt.message !== change.newDef.prompt.message ||
		JSON.stringify(change.oldDef?.schedules ?? []) !==
			JSON.stringify(change.newDef.schedules)
	);
}

async function removeFrontmatterSchedules(agentName: string): Promise<void> {
	for (const schedule of getSchedules()) {
		if (
			schedule.agentName === agentName &&
			schedule.createdBy === "scheduler" &&
			schedule.id.startsWith("frontmatter:")
		) {
			await removeSchedule(schedule.id);
		}
	}
}

async function syncFrontmatterSchedules(change: AgentChange): Promise<void> {
	if (!frontmatterSchedulesChanged(change)) return;

	const oldName = change.old?.name;
	const newName = change.newDef.name;
	if (oldName) await removeFrontmatterSchedules(oldName);
	if (oldName !== newName) await removeFrontmatterSchedules(newName);

	for (const [index, schedule] of change.newDef.schedules.entries()) {
		await addSchedule({
			id: frontmatterScheduleId(newName, index),
			agentName: newName,
			pattern: schedule.pattern,
			chatId: "system",
			objective: "# Message",
			...(schedule.overrides.length > 0
				? { overrides: schedule.overrides }
				: {}),
			...(schedule.label ? { label: schedule.label } : {}),
			createdBy: "scheduler",
			createdAt: new Date().toISOString(),
		});
	}
	log.info(`[watcher] schedules synced for @${newName}`);
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
		await syncFrontmatterSchedules(replaceAgentDefinition(newDef));
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
