// Suppress Bun's compat warnings for ws npm package event listeners
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
	if (typeof warning === "string" && warning.includes("ws.WebSocket")) return;
	// biome-ignore lint/suspicious/noExplicitAny: spread required for overloaded signature
	_emitWarning(warning, ...(args as any[]));
};

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { agentRegistry, loadAgents } from "./core/agent";
import { loadContextVariables, setContextVariables } from "./core/assemble";
import { dispatch } from "./core/dispatch";
import { initQueue } from "./core/queue";
import { loadAllTools } from "./core/registry";
import {
	loadSettingsFromDisk,
	stopSettingsWatcher,
	watchSettings,
} from "./core/settings-loader";
import { startWatching, stopWatching } from "./core/watcher";
import { startWorkers } from "./core/worker";
import { loadFlags } from "./flags";
import { log } from "./logger";
import { settings } from "./settings";
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
import { loadSkills, skillRegistry } from "./tools/skill";
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
	const { stopQueue } = await import("./core/queue");
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

async function main(): Promise<void> {
	// 0. Load settings from vault YAML (before anything else)
	const settingsResult = await loadSettingsFromDisk();
	if (!settingsResult.ok) {
		log.warn("[startup] settings.yml invalid or missing, using defaults", {
			error: settingsResult.error,
		});
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
	log.info("[startup] ensuring data directories", {
		dataDir: settings.dataDir,
	});
	const dirs = [
		settings.dataDir,
		path.join(settings.dataDir, "conversations"),
		path.join(settings.dataDir, "files"),
	];
	for (const dir of dirs) {
		await mkdir(dir, { recursive: true });
	}

	// 2. Load tools, agents (from vault), context variables, skills, flags
	log.info(
		"[startup] loading tools, agents, context variables, skills, and flags",
	);
	await loadAllTools(path.join(import.meta.dir, "tools"));
	await loadFlags(path.join(import.meta.dir, "flags"));

	const agentsDir = settings.vault.agentsDir;
	await mkdir(agentsDir, { recursive: true });
	await loadAgents(agentsDir);

	const contextVariables = await loadContextVariables(
		path.join(import.meta.dir, "context"),
	);
	setContextVariables(contextVariables);

	const snippetsDir = settings.vault.snippetsDir;
	await mkdir(snippetsDir, { recursive: true });

	const skillsDir = settings.vault.skillsDir;
	await mkdir(skillsDir, { recursive: true });
	await loadSkills(skillsDir);

	await import("./commands/register");

	// Validate skill references
	for (const def of agentRegistry.values()) {
		for (const skill of def.skills ?? []) {
			if (!skillRegistry.has(skill)) {
				log.warn("[startup] agent references unknown skill", {
					agent: def.name,
					skill,
				});
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
			log.info("[startup] registering frontmatter schedule", {
				agent: def.name,
				schedule: def.schedule,
			});
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

	// 6. Watch settings, agent, skill, and flag directories for hot-reload
	watchSettings();
	startWatching(agentsDir, skillsDir);

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

	log.info("[startup] ready", { port: PORT, whatsapp: getConnectionState() });

	// 8. Ensure login folder exists in vault (for QR code pairing).
	await ensureLoginFolder();

	// 9. Connect to WhatsApp in the background.
	log.info("[startup] connecting to WhatsApp");
	const warnAfterMs = settings.startup.connectionWarnAfterMs;
	const connectionWarnTimer = setTimeout(() => {
		if (!isConnected()) {
			log.warn(
				"[startup] WhatsApp pairing/connection is taking longer than expected",
				{
					warnAfterMs,
					whatsapp: getConnectionState(),
				},
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
			stack: err instanceof Error ? err.stack : undefined,
		});
	});
}

main().catch((err: unknown) => {
	log.error("[startup] fatal", {
		error: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	});
	process.exit(1);
});
