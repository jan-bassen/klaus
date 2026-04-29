/**
 * Bundled obsidian-headless supervisor.
 *
 * Spawns `ob sync --continuous` as a child process and keeps it alive for the
 * lifetime of the Klaus process so a single container delivers WhatsApp +
 * Obsidian Sync. Login state is pinned to a stable home/config directory under
 * `dataDir` so it persists across restarts via the existing data volume.
 *
 * CLI flags follow the obsidian-headless README.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { log } from "../logger.ts";

interface SyncEnv {
	email: string;
	password: string;
	vaultName: string;
	mfa?: string;
	e2eePassword?: string;
}

interface SyncDeps {
	vaultRoot: string;
	configDir: string;
	signal: AbortSignal;
	shutdownTimeoutMs: number;
	backoff: {
		initialMs: number;
		maxMs: number;
		resetAfterUpMs: number;
	};
	firstSync: {
		quietMs: number;
		timeoutMs: number;
	};
}

export interface SyncHandle {
	/** Resolves once the child has fully exited (after stop or abort). */
	stop(): Promise<void>;
}

type SyncError =
	| { kind: "missing-env"; vars: string[] }
	| {
			kind: "setup-failed";
			step: "login" | "sync-setup" | "sync-config" | "initial-pull";
			exitCode: number | null;
			stderr: string;
	  };

const MARKER_FILENAME = ".klaus-sync-ready";

export function readSyncEnv(
	env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: SyncEnv } | { ok: false; error: SyncError } {
	const missing: string[] = [];
	const email = env.OBSIDIAN_EMAIL;
	const password = env.OBSIDIAN_PASSWORD;
	const vaultName = env.OBSIDIAN_VAULT_NAME;
	if (!email) missing.push("OBSIDIAN_EMAIL");
	if (!password) missing.push("OBSIDIAN_PASSWORD");
	if (!vaultName) missing.push("OBSIDIAN_VAULT_NAME");
	if (!email || !password || !vaultName) {
		return { ok: false, error: { kind: "missing-env", vars: missing } };
	}
	return {
		ok: true,
		value: {
			email,
			password,
			vaultName,
			...(env.OBSIDIAN_MFA ? { mfa: env.OBSIDIAN_MFA } : {}),
			...(env.OBSIDIAN_E2EE_PASSWORD
				? { e2eePassword: env.OBSIDIAN_E2EE_PASSWORD }
				: {}),
		},
	};
}

function pipeWithPrefix(stream: Readable, kind: "out" | "err"): void {
	let buf = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		buf += chunk;
		let idx = buf.indexOf("\n");
		while (idx !== -1) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (line.length > 0) emitLine(line, kind);
			idx = buf.indexOf("\n");
		}
	});
	stream.on("end", () => {
		if (buf.length > 0) emitLine(buf, kind);
	});
}

function emitLine(line: string, kind: "out" | "err"): void {
	if (kind === "err") log.warn(`[sync] ${line}`);
	else log.info(`[sync] ${line}`);
}

function runOnce(
	args: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string },
): Promise<{ exitCode: number | null; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("ob", args, {
			...(opts.cwd ? { cwd: opts.cwd } : {}),
			...(opts.env ? { env: opts.env } : {}),
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		if (child.stdout) pipeWithPrefix(child.stdout, "out");
		if (child.stderr) {
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
				log.warn(`[sync] ${chunk.replace(/\n$/, "")}`);
			});
		}
		if (opts.stdin && child.stdin) {
			child.stdin.write(opts.stdin);
		}
		child.stdin?.end();
		child.on("error", (err) => {
			resolve({ exitCode: -1, stderr: `${stderr}${String(err)}` });
		});
		child.on("exit", (exitCode) => {
			resolve({ exitCode, stderr });
		});
	});
}

function obEnv(deps: SyncDeps): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: deps.configDir,
		XDG_CACHE_HOME: path.join(deps.configDir, "cache"),
		XDG_CONFIG_HOME: path.join(deps.configDir, "config"),
		XDG_DATA_HOME: path.join(deps.configDir, "data"),
	};
}

async function setSyncMode(
	mode: "bidirectional" | "mirror-remote",
	deps: SyncDeps,
	commandEnv: NodeJS.ProcessEnv,
): Promise<{ ok: true } | { ok: false; error: SyncError }> {
	log.info("[sync] setting sync mode", { mode });
	const result = await runOnce(
		["sync-config", "--path", deps.vaultRoot, "--mode", mode],
		{
			cwd: deps.vaultRoot,
			env: commandEnv,
		},
	);
	if (result.exitCode !== 0) {
		return {
			ok: false,
			error: {
				kind: "setup-failed",
				step: "sync-config",
				exitCode: result.exitCode,
				stderr: result.stderr,
			},
		};
	}
	return { ok: true };
}

async function ensureLoggedInAndLinked(
	env: SyncEnv,
	deps: SyncDeps,
): Promise<{ ok: true } | { ok: false; error: SyncError }> {
	const markerPath = path.join(deps.configDir, MARKER_FILENAME);
	if (existsSync(markerPath)) return { ok: true };

	await mkdir(deps.configDir, { recursive: true });
	const commandEnv = obEnv(deps);

	log.info("[sync] running first-time login");
	const loginArgs = ["login", "--email", env.email, "--password", env.password];
	if (env.mfa) loginArgs.push("--mfa", env.mfa);
	const loginResult = await runOnce(loginArgs, { env: commandEnv });
	if (loginResult.exitCode !== 0) {
		return {
			ok: false,
			error: {
				kind: "setup-failed",
				step: "login",
				exitCode: loginResult.exitCode,
				stderr: loginResult.stderr,
			},
		};
	}

	log.info("[sync] linking vault to remote", { vault: env.vaultName });
	const setupArgs = [
		"sync-setup",
		"--vault",
		env.vaultName,
		"--path",
		deps.vaultRoot,
	];
	if (env.e2eePassword) setupArgs.push("--password", env.e2eePassword);
	const setupResult = await runOnce(setupArgs, {
		cwd: deps.vaultRoot,
		env: commandEnv,
	});
	if (setupResult.exitCode !== 0) {
		return {
			ok: false,
			error: {
				kind: "setup-failed",
				step: "sync-setup",
				exitCode: setupResult.exitCode,
				stderr: setupResult.stderr,
			},
		};
	}

	await writeFile(markerPath, new Date().toISOString());
	return { ok: true };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const t = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});
}

export async function startSync(
	deps: SyncDeps,
): Promise<{ ok: true; handle: SyncHandle } | { ok: false; error: SyncError }> {
	const envResult = readSyncEnv();
	if (!envResult.ok) return { ok: false, error: envResult.error };
	const env = envResult.value;
	const commandEnv = obEnv(deps);

	const setup = await ensureLoggedInAndLinked(env, deps);
	if (!setup.ok) return { ok: false, error: setup.error };

	const mode = await setSyncMode("bidirectional", deps, commandEnv);
	if (!mode.ok) return { ok: false, error: mode.error };

	let stopped = false;
	let current: ChildProcess | null = null;
	let backoffMs = deps.backoff.initialMs;

	let firstSyncResolve: (() => void) | null = null;
	const firstSyncReady = new Promise<void>((resolve) => {
		firstSyncResolve = resolve;
	});

	const loop = (async (): Promise<void> => {
		let firstIteration = true;
		while (!stopped) {
			const startedAt = Date.now();
			const child = spawn(
				"ob",
				["sync", "--path", deps.vaultRoot, "--continuous"],
				{
					cwd: deps.vaultRoot,
					env: commandEnv,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			current = child;
			if (child.stdout) pipeWithPrefix(child.stdout, "out");
			if (child.stderr) pipeWithPrefix(child.stderr, "err");

			if (firstIteration) {
				firstIteration = false;
				attachFirstSyncGate(child, deps.firstSync, () => {
					firstSyncResolve?.();
					firstSyncResolve = null;
				});
			}

			const code = await new Promise<number | null>((resolve) => {
				child.on("error", (err) => {
					log.error("[sync] spawn error", { error: String(err) });
					resolve(-1);
				});
				child.on("exit", (c) => resolve(c));
			});
			current = null;
			if (stopped) return;

			const upMs = Date.now() - startedAt;
			if (upMs >= deps.backoff.resetAfterUpMs) {
				backoffMs = deps.backoff.initialMs;
			}
			log.warn("[sync] child exited, restarting", {
				exitCode: code,
				upMs,
				backoffMs,
			});
			await sleep(backoffMs, deps.signal);
			backoffMs = Math.min(backoffMs * 2, deps.backoff.maxMs);
		}
	})();

	const onAbort = (): void => {
		stopped = true;
		const child = current;
		if (!child) return;
		child.kill("SIGTERM");
		const t = setTimeout(() => {
			if (current === child) child.kill("SIGKILL");
		}, deps.shutdownTimeoutMs);
		t.unref();
	};
	if (deps.signal.aborted) onAbort();
	else deps.signal.addEventListener("abort", onAbort, { once: true });

	const timeoutPromise = new Promise<"timeout">((resolve) => {
		const t = setTimeout(() => resolve("timeout"), deps.firstSync.timeoutMs);
		t.unref();
	});
	const outcome = await Promise.race([
		firstSyncReady.then(() => "ready" as const),
		timeoutPromise,
	]);
	if (outcome === "timeout") {
		log.warn(
			"[sync] first-sync gate timed out, proceeding with possibly-stale vault",
			{ timeoutMs: deps.firstSync.timeoutMs },
		);
	} else {
		log.info("[sync] initial sync settled");
	}

	return {
		ok: true,
		handle: {
			async stop(): Promise<void> {
				if (!stopped) onAbort();
				await loop;
			},
		},
	};
}

export async function hydrateInitialVault(
	deps: SyncDeps,
): Promise<{ ok: true } | { ok: false; error: SyncError }> {
	const envResult = readSyncEnv();
	if (!envResult.ok) return { ok: false, error: envResult.error };
	const env = envResult.value;
	const commandEnv = obEnv(deps);

	const setup = await ensureLoggedInAndLinked(env, deps);
	if (!setup.ok) return { ok: false, error: setup.error };

	const mode = await setSyncMode("mirror-remote", deps, commandEnv);
	if (!mode.ok) return { ok: false, error: mode.error };

	log.info("[sync] mirroring remote vault before startup writes");
	const pullResult = await runOnce(["sync", "--path", deps.vaultRoot], {
		cwd: deps.vaultRoot,
		env: commandEnv,
	});
	if (pullResult.exitCode !== 0) {
		return {
			ok: false,
			error: {
				kind: "setup-failed",
				step: "initial-pull",
				exitCode: pullResult.exitCode,
				stderr: pullResult.stderr,
			},
		};
	}
	return { ok: true };
}

/**
 * Resolve once the child has been quiet for `quietMs` after at least one line
 * of output — heuristic for "initial sync settled, now just watching". The
 * obsidian-headless CLI doesn't expose a structured ready signal, so we
 * inactivity-detect on stdout/stderr instead.
 */
function attachFirstSyncGate(
	child: ChildProcess,
	opts: { quietMs: number },
	onReady: () => void,
): void {
	let sawOutput = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let done = false;

	const fire = (): void => {
		if (done) return;
		done = true;
		if (timer) clearTimeout(timer);
		onReady();
	};

	const bump = (): void => {
		if (done) return;
		sawOutput = true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(fire, opts.quietMs);
	};

	child.stdout?.on("data", bump);
	child.stderr?.on("data", bump);
	child.on("exit", () => {
		// If the first child exits before settling, unblock startup so the loop
		// can restart it under backoff — better than hanging the whole boot.
		if (!sawOutput) fire();
		else if (!done) fire();
	});
}
