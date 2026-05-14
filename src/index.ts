import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatUserError } from "./errors.ts";
import {
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
import { ensureVaultDefaults } from "./infra/vault/defaults.ts";
import {
	hydrateInitialVault,
	type SyncError,
	type SyncHandle,
	startSync,
} from "./infra/vault/sync.ts";
import { startWatching, stopWatching } from "./infra/vault/watcher.ts";
import {
	closeSocket,
	isConnected,
	startConnection,
} from "./infra/whatsapp/connection.ts";
import {
	completeSoloSetup,
	prepareLoginFolderForStartup,
} from "./infra/whatsapp/login.ts";
import { attachReceiveHandler } from "./infra/whatsapp/receive.ts";
import {
	drainQueue,
	enqueueMessage,
	setSocket,
} from "./infra/whatsapp/send.ts";
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

process.on("unhandledRejection", (reason) => {
	log.error("[process] unhandledRejection", {
		error: reason instanceof Error ? reason.message : String(reason),
	});
});
process.on("uncaughtException", (err) => {
	log.error("[process] uncaughtException", { error: err.message });
});

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

function failOnSyncError(err: SyncError, failureMsg: string): never {
	if (err.kind === "missing-env") {
		log.error("[startup] obsidian sync env vars missing", {
			missing: err.vars,
		});
	} else {
		log.error(failureMsg, {
			step: err.step,
			exitCode: err.exitCode,
			stderr: err.stderr,
		});
	}
	process.exit(1);
}

async function main(): Promise<void> {
	await mkdir(settings.vault.root, { recursive: true });
	const syncDeps = {
		vaultRoot: settings.vault.root,
		configDir: path.join(settings.dataDir, "obsidian-headless"),
		signal: shutdownController.signal,
		shutdownTimeoutMs: settings.sync.shutdownTimeoutMs,
		fileTypes: settings.sync.fileTypes,
		backoff: settings.sync.restartBackoff,
		firstSync: settings.sync.firstSync,
	};

	log.info(
		"[startup] hydrating vault via obsidian-headless in mirror-remote mode",
	);
	const pullResult = await hydrateInitialVault(syncDeps);
	if (!pullResult.ok) {
		failOnSyncError(pullResult.error, "[startup] obsidian initial pull failed");
	}

	await ensureVaultDefaults(settings.vault.internalPath);
	const settingsResult = await loadSettingsFromDisk();
	if (!settingsResult.ok) {
		log.warn("[startup] settings.yml invalid, using bundled defaults", {
			error: settingsResult.error,
			path: path.join(settings.vault.internalPath, "settings.yml"),
		});
	}

	const required = requiredStartupApiKeyEnvVars();
	const missing = required.filter((k) => !process.env[k]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required environment variables: ${missing.join(", ")}`,
		);
	}
	if (!settings.allowedChat) {
		if (settings.whatsapp.selfMode) {
			log.info(
				"[startup] self-mode enabled — allowedChat will auto-resolve on first message",
			);
		} else {
			log.warn(
				"[startup] allowedChat not configured — running in setup mode (messages will not be processed)",
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
	const syncResult = await startSync(syncDeps);
	if (!syncResult.ok) {
		failOnSyncError(syncResult.error, "[startup] obsidian sync setup failed");
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

	await prepareLoginFolderForStartup();

	log.info("[startup] connecting to WhatsApp");
	const warnAfterMs = settings.startup.connectionWarnAfterMs;
	const connectionWarnTimer = setTimeout(() => {
		if (!isConnected()) {
			log.warn(
				"[startup] WhatsApp pairing/connection is taking longer than expected",
			);
		}
	}, warnAfterMs);

	startConnection(async (socket) => {
		clearTimeout(connectionWarnTimer);
		setSocket(socket);
		if (!settings.allowedChat && settings.whatsapp.selfMode) {
			await completeSoloSetup().catch((err) =>
				log.error("[startup] solo setup failed", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		}
		attachReceiveHandler(socket);
		log.info("[startup] WhatsApp receive handler attached");
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
