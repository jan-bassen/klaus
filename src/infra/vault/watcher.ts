import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";
import { agentRegistry, loadAgentDefinition } from "../../pipeline/agents.ts";
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

function findAgentByPath(promptPath: string): { name: string } | undefined {
	for (const [name, def] of agentRegistry) {
		if (def.promptPath === promptPath) return { name };
	}
	return undefined;
}

function frontmatterScheduleId(agentName: string): string {
	return `frontmatter:${agentName}`;
}

export async function handleAgentChange(
	agentsDir: string,
	filename: string,
): Promise<void> {
	const promptPath = `${agentsDir}/${filename}`;
	const exists = existsSync(promptPath);

	if (!exists) {
		// File deleted — remove from registry and clean up schedule
		const old = findAgentByPath(promptPath);
		if (old) {
			const oldDef = agentRegistry.get(old.name);
			agentRegistry.delete(old.name);
			if (oldDef) {
				for (const alias of oldDef.aliases) agentRegistry.delete(alias);
			}
			await removeSchedule(frontmatterScheduleId(old.name));
			log.info(`[watcher] agent removed: @${old.name}`);
		}
		return;
	}

	// File added or modified — reload definition
	try {
		const newDef = await loadAgentDefinition(promptPath);

		// Find old entry by path (handles name changes)
		const old = findAgentByPath(promptPath);
		const oldDef = old ? agentRegistry.get(old.name) : undefined;

		// Clean up old aliases
		if (oldDef) {
			for (const alias of oldDef.aliases) agentRegistry.delete(alias);
		}

		// If name changed, remove old entry
		if (old && old.name !== newDef.name) {
			agentRegistry.delete(old.name);
			log.info(`[watcher] agent renamed: @${old.name} -> @${newDef.name}`);
		}

		agentRegistry.set(newDef.name, newDef);
		for (const alias of newDef.aliases) {
			agentRegistry.set(alias, newDef);
		}

		const oldStatic =
			oldDef?.persistence?.mode === "static" ? oldDef.persistence : null;
		const newStatic =
			newDef.persistence?.mode === "static" ? newDef.persistence : null;
		const nameChanged = old !== undefined && old.name !== newDef.name;

		const scheduleChanged =
			nameChanged ||
			oldStatic?.schedule !== newStatic?.schedule ||
			oldStatic?.prompt !== newStatic?.prompt ||
			JSON.stringify(oldStatic?.overrides ?? []) !==
				JSON.stringify(newStatic?.overrides ?? []);

		if (scheduleChanged) {
			const removedOld = old
				? await removeSchedule(frontmatterScheduleId(old.name))
				: false;
			const removedNew =
				old?.name !== newDef.name
					? await removeSchedule(frontmatterScheduleId(newDef.name))
					: false;
			if (removedOld || removedNew) {
				log.info(`[watcher] schedule removed for @${old?.name ?? newDef.name}`);
			}

			if (newStatic) {
				await addSchedule({
					id: frontmatterScheduleId(newDef.name),
					agentName: newDef.name,
					pattern: newStatic.schedule,
					chatId: "system",
					objective: newStatic.prompt,
					...(newStatic.overrides.length > 0
						? { overrides: newStatic.overrides }
						: {}),
					label: `${newDef.name} (frontmatter)`,
					createdBy: "scheduler",
					createdAt: new Date().toISOString(),
				});
				log.info(
					`[watcher] schedule registered for @${newDef.name}: ${newStatic.schedule}`,
				);
			}
		}

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
		if (!filename || !filename.endsWith(".md")) return;
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
		if (!filename || !filename.endsWith(".md")) return;
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
					loadSettingsFromDisk().then((r) => {
						if (!r.ok) {
							log.warn(
								"[watcher] settings reload failed, keeping last valid config",
							);
							warnSettingsInvalid(r.error);
						}
					});
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
			if (!filename || !filename.endsWith(".md")) return;
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
