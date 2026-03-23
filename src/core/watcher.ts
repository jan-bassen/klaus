import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
	FlagFrontmatterSchema,
	type FlagMeta,
	flagRegistry,
} from "@/core/flags";
import { log } from "@/logger";
import { settings } from "@/settings";
import { addSchedule, findSchedule, removeSchedule } from "@/store/schedules";
import {
	SkillFrontmatterSchema,
	type SkillMeta,
	skillRegistry,
} from "@/tools/skill";
import { agentRegistry, loadAgentDefinition } from "./agent";

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
		}, settings.watcher.debounceMs),
	);
}

function findAgentByPath(promptPath: string): { name: string } | undefined {
	for (const [name, def] of agentRegistry) {
		if (def.promptPath === promptPath) return { name };
	}
	return undefined;
}

async function handleAgentChange(
	agentsDir: string,
	filename: string,
): Promise<void> {
	const promptPath = `${agentsDir}/${filename}`;
	const exists = existsSync(promptPath);

	if (!exists) {
		// File deleted — remove from registry and clean up schedule
		const old = findAgentByPath(promptPath);
		if (old) {
			agentRegistry.delete(old.name);
			const schedule = findSchedule(old.name);
			if (schedule) await removeSchedule(schedule.id);
			log.info("[watcher] agent removed", { name: old.name, file: filename });
		}
		return;
	}

	// File added or modified — reload definition
	try {
		const newDef = await loadAgentDefinition(promptPath);

		// Find old entry by path (handles name changes)
		const old = findAgentByPath(promptPath);
		const oldDef = old ? agentRegistry.get(old.name) : undefined;

		// If name changed, remove old entry
		if (old && old.name !== newDef.name) {
			agentRegistry.delete(old.name);
			log.info("[watcher] agent renamed", {
				from: old.name,
				to: newDef.name,
			});
		}

		agentRegistry.set(newDef.name, newDef);

		// Reconcile schedule
		const oldSchedule = oldDef?.schedule;
		const newSchedule = newDef.schedule;

		if (oldSchedule !== newSchedule) {
			// Remove old schedule
			const existingSchedule = findSchedule(old?.name ?? newDef.name);
			if (existingSchedule) {
				await removeSchedule(existingSchedule.id);
				log.info("[watcher] schedule removed", {
					agent: old?.name ?? newDef.name,
				});
			}

			if (newSchedule) {
				await addSchedule({
					id: `frontmatter:${newDef.name}`,
					agentName: newDef.name,
					pattern: newSchedule,
					chatId: "system",
					objective: `Scheduled run of ${newDef.name}`,
					label: `${newDef.name} (frontmatter)`,
					createdBy: "scheduler",
					createdAt: new Date().toISOString(),
				});
				log.info("[watcher] schedule registered", {
					agent: newDef.name,
					schedule: newSchedule,
				});
			}
		}

		log.info("[watcher] agent reloaded", {
			name: newDef.name,
			file: filename,
		});
	} catch (err) {
		log.warn("[watcher] failed to reload agent", {
			file: filename,
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
		log.info("[watcher] skill removed", { name });
		return;
	}

	try {
		const raw = await Bun.file(filePath).text();
		const match = raw.match(/^---\n([\s\S]*?)\n---/);
		let description = name;
		if (match) {
			const front = SkillFrontmatterSchema.safeParse(parseYaml(match[1] ?? ""));
			if (front.success && front.data.description) {
				description = front.data.description;
			}
		}
		skillRegistry.set(name, { name, description } satisfies SkillMeta);
		log.info("[watcher] skill reloaded", { name });
	} catch (err) {
		log.warn("[watcher] failed to reload skill", {
			file: filename,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function handleFlagChange(
	flagsDir: string,
	filename: string,
): Promise<void> {
	const filePath = `${flagsDir}/${filename}`;
	const name = filename.replace(/\.md$/, "");
	const exists = existsSync(filePath);

	if (!exists) {
		flagRegistry.delete(name);
		log.info("[watcher] flag removed", { name });
		return;
	}

	try {
		const raw = await Bun.file(filePath).text();
		const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);

		let description = name;
		let prompt = raw.trim();

		if (match) {
			const front = FlagFrontmatterSchema.safeParse(parseYaml(match[1] ?? ""));
			if (front.success && front.data.description) {
				description = front.data.description;
			}
			prompt = raw.slice(match[0].length).trim();
		}

		flagRegistry.set(name, { name, description, prompt } satisfies FlagMeta);
		log.info("[watcher] flag reloaded", { name });
	} catch (err) {
		log.warn("[watcher] failed to reload flag", {
			file: filename,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export function startWatching(
	agentsDir: string,
	skillsDir: string,
	flagsDir: string,
): void {
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

	const flagWatcher = watch(flagsDir, (_event, filename) => {
		if (!filename || !filename.endsWith(".md")) return;
		debounce(`flag:${filename}`, () => {
			handleFlagChange(flagsDir, filename).catch((err) =>
				log.error("[watcher] unhandled error in flag handler", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		});
	});
	watchers.push(flagWatcher);

	log.info("[watcher] watching for changes", {
		agentsDir,
		skillsDir,
		flagsDir,
	});
}

export function stopWatching(): void {
	for (const w of watchers) w.close();
	watchers.length = 0;
	for (const timer of debounceTimers.values()) clearTimeout(timer);
	debounceTimers.clear();
}
