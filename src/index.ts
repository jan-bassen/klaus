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
import { initQueue, registerCronCallback } from "./core/queue";
import { loadAllTools } from "./core/registry";
import { startWatching, stopWatching } from "./core/watcher";
import { startWorkers } from "./core/worker";
import { loadFlags } from "./flags";
import { log } from "./logger";
import { settings } from "./settings";
import { loadBudgets } from "./store/budgets";
import { rebuildIndexes as rebuildConversationIndexes } from "./store/conversation";
import { rebuildFileIndex } from "./store/files";
import { loadSchedules } from "./store/schedules";
import { recoverRunningTasks } from "./store/tasks";
import { loadSkills, skillRegistry } from "./tools/skill";
import {
	closeSocket,
	getConnectionState,
	isConnected,
	startConnection,
} from "./whatsapp/connection";
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
	stopWatching();

	// 5. Stop cron schedules.
	const { stopAllSchedules } = await import("./store/schedules");
	stopAllSchedules();

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
	// 0. Validate required env vars
	const required = ["ANTHROPIC_API_KEY", "ALLOWED_CHAT_ID"] as const;
	const missing = required.filter((k) => !process.env[k]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required environment variables: ${missing.join(", ")}`,
		);
	}

	// 1. Ensure directory structure
	log.info("[startup] ensuring data directories", {
		dataDir: settings.dataDir,
	});
	const dirs = [
		settings.dataDir,
		path.join(settings.dataDir, "conversations"),
		path.join(settings.dataDir, "conversations", "archive"),
		path.join(settings.dataDir, "tasks"),
		path.join(settings.dataDir, "tasks", "pending"),
		path.join(settings.dataDir, "tasks", "running"),
		path.join(settings.dataDir, "tasks", "done"),
		path.join(settings.dataDir, "tasks", "failed"),
		path.join(settings.dataDir, "tasks", "cancelled"),
		path.join(settings.dataDir, "costs"),
		path.join(settings.dataDir, "invocations"),
		path.join(settings.dataDir, "files"),
	];
	for (const dir of dirs) {
		await mkdir(dir, { recursive: true });
	}

	// 2. Load tools, agents (from vault), context variables, skills, flags (from vault)
	log.info(
		"[startup] loading tools, agents, context variables, skills, and flags",
	);
	await loadAllTools(path.join(import.meta.dir, "tools"));

	const agentsDir = path.join(settings.vault.dir, "Klaus", "agents");
	await mkdir(agentsDir, { recursive: true });
	await loadAgents(agentsDir);

	const contextVariables = await loadContextVariables(
		path.join(import.meta.dir, "context"),
	);
	setContextVariables(contextVariables);

	const snippetsDir = path.join(settings.vault.dir, "Klaus", "snippets");
	await mkdir(snippetsDir, { recursive: true });

	const skillsDir = path.join(settings.vault.dir, "Klaus", "skills");
	await mkdir(skillsDir, { recursive: true });
	await loadSkills(skillsDir);

	const flagsDir = path.join(settings.vault.dir, "Klaus", "flags");
	await mkdir(flagsDir, { recursive: true });
	await loadFlags(flagsDir);

	const notesDir = path.join(settings.vault.dir, "Klaus", "notes");
	await mkdir(notesDir, { recursive: true });

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

	// 4. Init in-memory queue, recover tasks
	log.info("[startup] initializing queue and workers");
	await recoverRunningTasks();
	await initQueue();
	await startWorkers();

	// 5. Load and register cron schedules
	await loadSchedules();
	await loadBudgets();

	// Register cron schedules for agents that declare a schedule field
	for (const def of agentRegistry.values()) {
		if (def.schedule) {
			log.info("[startup] registering cron schedule", {
				agent: def.name,
				schedule: def.schedule,
			});
			await dispatch({
				agent: def.name,
				objective: `Scheduled run of ${def.name}`,
				mode: { kind: "cron", schedule: def.schedule },
				chatId: "system",
				caller: "scheduler",
			});
		}
	}

	// Start cron evaluation
	registerCronCallback(async (entry) => {
		const stored = entry.payload as {
			dispatchContext?: { objective?: string; hint?: string; caller?: string };
		};
		const ctx = stored.dispatchContext;
		await dispatch({
			agent: entry.agentName,
			objective: ctx?.objective ?? `Scheduled run of ${entry.agentName}`,
			...(ctx?.hint !== undefined && { hint: ctx.hint }),
			mode: { kind: "async" },
			chatId: entry.chatId,
			caller: ctx?.caller ?? "scheduler",
		});
	});

	// 6. Watch agent, skill, and flag directories for hot-reload
	startWatching(agentsDir, skillsDir, flagsDir);

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

	// 8. Connect to WhatsApp in the background.
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

	startConnection()
		.then((socket) => {
			clearTimeout(connectionWarnTimer);
			attachReceiveHandler(socket);
			log.info("[startup] WhatsApp receive handler attached");
		})
		.catch((err: unknown) => {
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
