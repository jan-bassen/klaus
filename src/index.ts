// Suppress Bun's compat warnings for ws npm package event listeners
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
	if (typeof warning === "string" && warning.includes("ws.WebSocket")) return;
	// biome-ignore lint/suspicious/noExplicitAny: spread required for overloaded signature
	_emitWarning(warning, ...(args as any[]));
};

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { agentRegistry, loadAgents } from "./agent/definitions";
import { dispatch, startWorkers } from "./agent/dispatch";
import { initQueue } from "./agent/queue";
import {
	loadSettingsFromDisk,
	settings,
	stopSettingsWatcher,
	watchSettings,
} from "./config";
import { log } from "./logger";
import { loadOverrides } from "./pipeline/overrides";
import { createServices, setServices } from "./services";
import { rebuildIndexes as rebuildConversationIndexes } from "./store/conversation";
import { rebuildFileIndex } from "./store/files";
import {
	addSchedule,
	loadSchedules,
	setOnCronFire,
	startAllSchedules,
	stopAllSchedules,
} from "./store/schedules";
import { loadTimers, setOnTimerFire, stopAllTimers } from "./store/timers";
import { loadAllTools } from "./variables/tools";
import { loadSkills, skillRegistry } from "./variables/tools/skill";
import { loadVariables, setVariables } from "./variables";
import { startWatching, stopWatching } from "./vault/watcher";
import {
	closeSocket,
	getConnectionState,
	isConnected,
	startConnection,
} from "./whatsapp/connection";
import { ensureLoginFolder } from "./whatsapp/login";
import { attachReceiveHandler } from "./whatsapp/receive";
import { drainQueue } from "./whatsapp/send";

const PORT = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
	throw new Error(
		`Invalid PORT: "${process.env.PORT}" — must be an integer between 1 and 65535`,
	);
}

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log.info("[shutdown] received signal, shutting down gracefully", { signal });

	// 1. Drain the outbound send queue (max 5s).
	await Promise.race([
		drainQueue(),
		new Promise<void>((r) => setTimeout(r, 5_000)),
	]);

	// 2. Close WhatsApp socket.
	closeSocket();

	// 3. Stop the in-memory queue.
	const { stopQueue } = await import("./agent/queue");
	await stopQueue();

	// 4. Stop file watchers.
	stopSettingsWatcher();
	stopWatching();

	// 5. Stop cron schedules and timers.
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
 * Copy default vault files from defaults/Klaus/ to the vault's internal path.
 * Only copies files that don't already exist — never overwrites user customizations.
 */
async function ensureDefaults(targetDir: string): Promise<void> {
	const defaultsDir = path.join(import.meta.dir, "..", "Klaus");
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

async function main(): Promise<void> {
	// 0. Ensure default vault files exist, then load settings
	await ensureDefaults(settings.vault.internalPath);
	const settingsResult = await loadSettingsFromDisk();
	if (!settingsResult.ok) {
		log.warn("[startup] settings.yml invalid or missing, using defaults");
	}

	// 1. Validate required env vars
	const required = ["ANTHROPIC_API_KEY"] as const;
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

	// 1. Ensure directory structure
	log.info("[startup] ensuring data directories");
	const dirs = [
		settings.dataDir,
		path.join(settings.dataDir, "conversations"),
		path.join(settings.dataDir, "files"),
	];
	for (const dir of dirs) {
		await mkdir(dir, { recursive: true });
	}

	// 1b. Initialise the services container — every module-level store function
	// resolves through it, so this must run before any store call.
	setServices(
		createServices({
			dataDir: settings.dataDir,
			timezone: settings.timezone,
		}),
	);

	// 2. Load tools, agents (from vault), variables, skills, overrides
	log.info("[startup] loading tools, agents, variables, skills, and overrides");
	await loadAllTools(path.join(import.meta.dir, "tools"));
	await loadOverrides();

	const agentsDir = settings.vault.agentsDir;
	await loadAgents(agentsDir);

	const variables = await loadVariables(
		path.join(import.meta.dir, "variables"),
	);
	setVariables(variables);

	await loadSkills(settings.vault.skillsDir);

	const { loadCommands } = await import("./commands");
	await loadCommands(path.join(import.meta.dir, "commands"));

	// Validate skill references
	for (const def of agentRegistry.values()) {
		for (const skill of def.skills ?? []) {
			if (!skillRegistry.has(skill)) {
				log.warn(
					`[startup] agent @${def.name} references unknown skill: ${skill}`,
				);
			}
		}
	}

	// 3. Build in-memory indexes
	log.info("[startup] building in-memory indexes");
	await rebuildConversationIndexes();
	await rebuildFileIndex();

	// 4. Init in-memory queue and workers
	log.info("[startup] initializing queue and workers");
	await initQueue();
	await startWorkers();

	// 5. Load schedules and timers, register callbacks
	await loadSchedules();
	// Register frontmatter schedules for agents that declare a schedule field
	for (const def of agentRegistry.values()) {
		if (def.schedule) {
			log.info(
				`[startup] registering schedule for @${def.name}: ${def.schedule}`,
			);
			await addSchedule({
				id: `frontmatter:${def.name}`,
				agentName: def.name,
				pattern: def.schedule,
				chatId: "system",
				objective: `Scheduled run of ${def.name}`,
				label: `${def.name} (frontmatter)`,
				createdBy: "scheduler",
				createdAt: new Date().toISOString(),
			});
		}
	}

	// Register cron fire callback — dispatches scheduled agents into the queue
	setOnCronFire(async (entry) => {
		await dispatch({
			agent: entry.agentName,
			objective: entry.objective,
			...(entry.hint ? { hint: entry.hint } : {}),
			mode: { kind: "async" },
			chatId: entry.chatId,
			caller: entry.createdBy,
		});
	});
	startAllSchedules();

	// Register timer fire callback — dispatches timed agents into the queue
	setOnTimerFire(async (entry) => {
		await dispatch({
			agent: entry.agentName,
			objective: entry.objective,
			...(entry.hint ? { hint: entry.hint } : {}),
			mode: { kind: "async" },
			chatId: entry.chatId,
			caller: entry.createdBy,
		});
	});
	await loadTimers();

	// 6. Watch settings, agents, skills, and overrides for hot-reload
	watchSettings();
	startWatching(agentsDir, settings.vault.skillsDir);

	// 7. Start HTTP server before WhatsApp so the process stays up during first-time pairing.
	Bun.serve({
		port: PORT,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/healthz") {
				const whatsapp = getConnectionState();
				const status = isConnected() ? "ok" : "degraded";
				const version = process.env.VERSION ?? "dev";
				return Response.json({
					status,
					ts: new Date().toISOString(),
					whatsapp,
					version,
				});
			}
			return new Response("Not Found", { status: 404 });
		},
	});

	log.info(`[startup] ready on port ${PORT}`);

	// 8. Ensure login folder exists in vault (for QR code pairing).
	await ensureLoginFolder();

	// 9. Connect to WhatsApp in the background.
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
