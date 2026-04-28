/**
 * Bundled obsidian-headless supervisor.
 *
 * Spawns `ob sync --continuous` as a child process and keeps it alive for the
 * lifetime of the Klaus process so a single container delivers WhatsApp +
 * Obsidian Sync. Login state is pinned to a stable `--config-dir` under
 * `dataDir` so it persists across restarts via the existing data volume.
 *
 * CLI flags follow the obsidian-headless README. Where the README is silent
 * (e.g. the exact flag name for an E2EE vault password), the code below is a
 * best-effort first impl — verify with `ob <cmd> --help` if it doesn't take.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { log } from "@/infra/logger";

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
}

export interface SyncHandle {
	/** Resolves once the child has fully exited (after stop or abort). */
	stop(): Promise<void>;
}

type SyncError =
	| { kind: "missing-env"; vars: string[] }
	| {
			kind: "setup-failed";
			step: "login" | "sync-setup";
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
	opts: { cwd?: string; stdin?: string },
): Promise<{ exitCode: number | null; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("ob", args, {
			...(opts.cwd ? { cwd: opts.cwd } : {}),
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

async function ensureLoggedInAndLinked(
	env: SyncEnv,
	deps: SyncDeps,
): Promise<{ ok: true } | { ok: false; error: SyncError }> {
	const markerPath = path.join(deps.configDir, MARKER_FILENAME);
	if (existsSync(markerPath)) return { ok: true };

	await mkdir(deps.configDir, { recursive: true });

	log.info("[sync] running first-time login");
	const loginArgs = [
		"--config-dir",
		deps.configDir,
		"login",
		"--email",
		env.email,
		"--password",
		env.password,
	];
	if (env.mfa) loginArgs.push("--mfa", env.mfa);
	const loginResult = await runOnce(loginArgs, {});
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
		"--config-dir",
		deps.configDir,
		"sync-setup",
		"--vault",
		env.vaultName,
	];
	// The README doesn't enumerate the E2EE password flag; piping it on stdin
	// is a safe fallback for prompted credential reads.
	const setupResult = await runOnce(setupArgs, {
		cwd: deps.vaultRoot,
		...(env.e2eePassword ? { stdin: `${env.e2eePassword}\n` } : {}),
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

	const setup = await ensureLoggedInAndLinked(env, deps);
	if (!setup.ok) return { ok: false, error: setup.error };

	let stopped = false;
	let current: ChildProcess | null = null;
	let backoffMs = deps.backoff.initialMs;

	const loop = (async (): Promise<void> => {
		while (!stopped) {
			const startedAt = Date.now();
			const child = spawn(
				"ob",
				["--config-dir", deps.configDir, "sync", "--continuous"],
				{
					cwd: deps.vaultRoot,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			current = child;
			if (child.stdout) pipeWithPrefix(child.stdout, "out");
			if (child.stderr) pipeWithPrefix(child.stderr, "err");

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
