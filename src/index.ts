import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatUserError } from "./errors.ts";
import {
	bundledVaultDir,
	loadSettingsFromDisk,
	requiredStartupApiKeyEnvVars,
	settings,
} from "./infra/config.ts";
import { log } from "./infra/logger.ts";
import { initFilesStore, rebuildFileIndex } from "./infra/store/files.ts";
import {
	initHistoryStore,
	rebuildIndexes as rebuildConversationIndexes,
} from "./infra/store/history.ts";
import { initReportStore } from "./infra/store/report.ts";
import {
	addSchedule,
	initSchedulesStore,
	loadSchedules,
	type ScheduleEntry,
	setOnCronFire,
	startAllSchedules,
	stopAllSchedules,
} from "./infra/store/schedules.ts";
import {
	initTimersStore,
	loadTimers,
	setOnTimerFire,
	stopAllTimers,
	type TimerEntry,
} from "./infra/store/timers.ts";
import { type SyncHandle, startSync } from "./infra/vault/sync.ts";
import { startWatching, stopWatching } from "./infra/vault/watcher.ts";
import {
	closeSocket,
	isConnected,
	startConnection,
} from "./infra/whatsapp/connection.ts";
import { ensureLoginFolder, startSoloWatcher } from "./infra/whatsapp/login.ts";
import { attachReceiveHandler } from "./infra/whatsapp/receive.ts";
import { drainQueue, enqueueMessage } from "./infra/whatsapp/send.ts";
import { agentRegistry, loadAgents } from "./pipeline/agents.ts";
import type { Trigger } from "./pipeline/core.ts";
import { dispatch } from "./pipeline/dispatch.ts";
import { loadOverrides } from "./pipeline/overrides.ts";
import { loadTemplates } from "./pipeline/prompts.ts";
import { loadAllTools } from "./primitives/tools/index.ts";
import { loadSkills, skillRegistry } from "./primitives/tools/skill.ts";
import { loadVariables, setVariables } from "./primitives/variables/index.ts";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

let shuttingDown = false;
const shutdownController = new AbortController();
let syncHandle: SyncHandle | null = null;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info("[shutdown] received signal, shutting down gracefully", { signal });

	shutdownController.abort();

	await Promise.race([
		Promise.all([drainQueue(), syncHandle?.stop() ?? Promise.resolve()]),
		new Promise<void>((r) => setTimeout(r, 10_000)),
	]);

	closeSocket();

	stopWatching();
	stopAllSchedules();
	stopAllTimers();

	log.info("[shutdown] complete");
	process.exit(0);
}
process.on("SIGTERM", () => {
	shutdown("SIGTERM").catch(() => process.exit(1));
});
process.on("SIGINT", () => {
	shutdown("SIGINT").catch(() => process.exit(1));
});

/**
 * Copy default vault files from the repo's vault/ folder to the vault's internal path.
 * Only copies files that don't already exist — never overwrites user customizations.
 */
async function ensureDefaults(targetDir: string): Promise<void> {
	const defaultsDir = bundledVaultDir;
	if (!existsSync(defaultsDir)) return;

	async function copyDir(src: string, dest: string): Promise<void> {
		await mkdir(dest, { recursive: true });
		const entries = await readdir(src, { withFileTypes: true });
		for (const entry of entries) {
			const srcPath = path.join(src, entry.name);
			const destPath = path.join(dest, entry.name);
			if (entry.isDirectory()) {
				await copyDir(srcPath, destPath);
			} else if (!existsSync(destPath)) {
				await copyFile(srcPath, destPath);
				log.info(`[startup] copied default file: ${destPath}`);
			}
		}
	}

	await copyDir(defaultsDir, targetDir);
}

async function runScheduledDispatch(
	source: "cron" | "timer",
	entry: ScheduleEntry | TimerEntry,
	trigger: Trigger,
): Promise<void> {
	try {
		await dispatch({
			agent: entry.agentName,
			prompt: entry.objective,
			...(entry.overrides ? { overrides: entry.overrides } : {}),
			chatId: entry.chatId,
			trigger,
		});
	} catch (err) {
		log.error(`[${source}] dispatch failed`, {
			[`${source === "cron" ? "schedule" : "timer"}Id`]: entry.id,
			error: err,
		});
		enqueueMessage({
			chatId: entry.chatId,
			content: `⚠️ Scheduled @${entry.agentName} run failed:\n${formatUserError(err)}`,
			dedupKey: `${source}-error:${entry.id}:${Date.now()}`,
			label: settings.whatsapp.systemLabel,
		});
	}
}

async function main(): Promise<void> {
	await ensureDefaults(settings.vault.internalPath);
	const settingsResult = await loadSettingsFromDisk();
	if (!settingsResult.ok) {
		log.warn("[startup] settings.yml invalid or missing, using defaults");
	}

	const required = requiredStartupApiKeyEnvVars();
	const missing = required.filter((k) => !process.env[k]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required environment variables: ${missing.join(", ")}`,
		);
	}
	if (!settings.allowedChatId) {
		if (settings.whatsapp.selfMode) {
			log.info(
				"[startup] self-mode enabled — allowedChatId will auto-resolve on first message",
			);
		} else {
			log.warn(
				"[startup] allowedChatId not configured — running in setup mode (messages will not be processed)",
			);
		}
	}

	log.info("[startup] ensuring data directories");
	const dirs = [
		settings.dataDir,
		path.join(settings.dataDir, "conversations"),
		path.join(settings.dataDir, "files"),
		path.join(settings.dataDir, "logs"),
	];
	for (const dir of dirs) {
		await mkdir(dir, { recursive: true });
	}

	log.info("[startup] starting bundled obsidian-headless sync");
	const syncResult = await startSync({
		vaultRoot: settings.vault.root,
		configDir: path.join(settings.dataDir, "obsidian-headless"),
		signal: shutdownController.signal,
		shutdownTimeoutMs: settings.sync.shutdownTimeoutMs,
		backoff: settings.sync.restartBackoff,
		firstSync: settings.sync.firstSync,
	});
	if (!syncResult.ok) {
		const err = syncResult.error;
		if (err.kind === "missing-env") {
			log.error("[startup] obsidian sync env vars missing", {
				missing: err.vars,
			});
		} else {
			log.error("[startup] obsidian sync setup failed", {
				step: err.step,
				exitCode: err.exitCode,
				stderr: err.stderr,
			});
		}
		process.exit(1);
	}
	syncHandle = syncResult.handle;

	initHistoryStore({ dataDir: settings.dataDir });
	initFilesStore({ dataDir: settings.dataDir });
	initReportStore({ dataDir: settings.dataDir });
	initSchedulesStore({
		dataDir: settings.dataDir,
		timezone: settings.timezone,
	});
	initTimersStore({ dataDir: settings.dataDir });

	log.info("[startup] loading tools, agents, variables, skills, and overrides");
	await loadAllTools(path.join(MODULE_DIR, "primitives", "tools"));
	await loadOverrides();
	loadTemplates();

	const agentsDir = settings.vault.agentsDir;
	await loadAgents(agentsDir);

	const variables = await loadVariables(
		path.join(MODULE_DIR, "primitives", "variables"),
	);
	setVariables(variables);

	await loadSkills(settings.vault.skillsDir);

	const { loadCommands } = await import("./primitives/commands/index.ts");
	await loadCommands(path.join(MODULE_DIR, "primitives", "commands"));

	for (const def of agentRegistry.values()) {
		for (const skill of def.skills ?? []) {
			if (!skillRegistry.has(skill)) {
				log.warn(
					`[startup] agent @${def.name} references unknown skill: ${skill}`,
				);
			}
		}
	}

	log.info("[startup] building in-memory indexes");
	await rebuildConversationIndexes();
	await rebuildFileIndex();

	await loadSchedules();
	for (const def of agentRegistry.values()) {
		if (def.persistence?.mode !== "static") continue;
		log.info(
			`[startup] registering static schedule for @${def.name}: ${def.persistence.schedule}`,
		);
		await addSchedule({
			id: `frontmatter:${def.name}`,
			agentName: def.name,
			pattern: def.persistence.schedule,
			chatId: "system",
			objective: def.persistence.prompt,
			...(def.persistence.overrides.length > 0
				? { overrides: def.persistence.overrides }
				: {}),
			label: `${def.name} (frontmatter)`,
			createdBy: "scheduler",
			createdAt: new Date().toISOString(),
		});
	}

	setOnCronFire(async (entry) => {
		await runScheduledDispatch("cron", entry, {
			kind: "schedule",
			scheduleId: entry.id,
		});
	});
	startAllSchedules();

	setOnTimerFire(async (entry) => {
		await runScheduledDispatch("timer", entry, {
			kind: "timer",
			timerId: entry.id,
		});
	});
	await loadTimers();

	startWatching(agentsDir, settings.vault.skillsDir);

	log.info("[startup] ready");

	await ensureLoginFolder();

	log.info("[startup] connecting to WhatsApp");
	const warnAfterMs = settings.startup.connectionWarnAfterMs;
	const connectionWarnTimer = setTimeout(() => {
		if (!isConnected()) {
			log.warn(
				"[startup] WhatsApp pairing/connection is taking longer than expected",
			);
		}
	}, warnAfterMs);

	startConnection((socket) => {
		clearTimeout(connectionWarnTimer);
		attachReceiveHandler(socket);
		log.info("[startup] WhatsApp receive handler attached");
		if (!settings.allowedChatId) startSoloWatcher();
	}).catch((err: unknown) => {
		clearTimeout(connectionWarnTimer);
		log.error("[startup] WhatsApp connection failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

main().catch((err: unknown) => {
	log.error("[startup] fatal", {
		error: err instanceof Error ? err.message : String(err),
	});
	process.exit(1);
});
