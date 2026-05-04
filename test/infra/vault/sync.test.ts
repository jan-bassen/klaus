/**
 * `infra/vault/sync.ts` — obsidian-headless supervisor.
 *
 * `node:child_process.spawn` is fully mocked. Each spawn returns a fake
 * EventEmitter-based ChildProcess so we can drive exit/error events
 * deterministically and inspect the args Klaus passed to `ob`.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

interface FakeChild extends EventEmitter {
	stdout: EventEmitter & { setEncoding: (e: string) => void };
	stderr: EventEmitter & { setEncoding: (e: string) => void };
	stdin: { write: (s: string) => void; end: () => void };
	kill: (signal?: string) => boolean;
	killed: boolean;
	__signals: string[];
}

function makeFakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	const stdout = new EventEmitter() as FakeChild["stdout"];
	const stderr = new EventEmitter() as FakeChild["stderr"];
	stdout.setEncoding = () => {};
	stderr.setEncoding = () => {};
	child.stdout = stdout;
	child.stderr = stderr;
	child.stdin = { write: () => {}, end: () => {} };
	child.killed = false;
	child.__signals = [];
	child.kill = (signal = "SIGTERM") => {
		child.__signals.push(signal);
		return true;
	};
	return child;
}

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

// Re-import after the mock is registered.
import {
	hydrateInitialVault,
	readSyncEnv,
	startSync,
} from "../../../src/infra/vault/sync.ts";

const ORIGINAL_ENV = { ...process.env };

function setEnv(vars: Record<string, string | undefined>): void {
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

function setValidSyncEnv(
	overrides: Record<string, string | undefined> = {},
): void {
	setEnv({
		OBSIDIAN_EMAIL: "a@b.c",
		OBSIDIAN_PASSWORD: "pw",
		OBSIDIAN_VAULT_NAME: "MyVault",
		...overrides,
	});
}

function markSyncReady(configDir: string): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(path.join(configDir, ".klaus-sync-ready"), "now");
}

function startOptions(
	tmp: string,
	configDir: string,
	signal: AbortSignal,
	shutdownTimeoutMs = 50,
	backoff = { initialMs: 1, maxMs: 10, resetAfterUpMs: 1000 },
) {
	return {
		vaultRoot: tmp,
		configDir,
		signal,
		shutdownTimeoutMs,
		fileTypes: ["image", "audio", "video", "pdf", "unsupported"] as const,
		backoff,
		firstSync: { quietMs: 5, timeoutMs: 200 },
	};
}

function queueFirstRunChildren(): {
	loginChild: FakeChild;
	setupChild: FakeChild;
	modeChild: FakeChild;
	continuousChild: FakeChild;
} {
	const loginChild = makeFakeChild();
	const setupChild = makeFakeChild();
	const modeChild = makeFakeChild();
	const continuousChild = makeFakeChild();
	spawnMock
		.mockReturnValueOnce(loginChild)
		.mockReturnValueOnce(setupChild)
		.mockReturnValueOnce(modeChild)
		.mockReturnValueOnce(continuousChild);
	return {
		loginChild,
		setupChild,
		modeChild,
		continuousChild,
	};
}

async function finishFirstRun(
	loginChild: FakeChild,
	setupChild: FakeChild,
	modeChild: FakeChild,
	continuousChild: FakeChild,
	startPromise: ReturnType<typeof startSync>,
): Promise<Awaited<ReturnType<typeof startSync>>> {
	await waitForSpawnCount(1);
	loginChild.emit("exit", 0);
	await waitForSpawnCount(2);
	setupChild.emit("exit", 0);
	await waitForSpawnCount(3);
	modeChild.emit("exit", 0);
	await waitForSpawnCount(4);
	continuousChild.stdout.emit("data", "watching\n");
	return startPromise;
}

async function stopStartedSync(
	result: Awaited<ReturnType<typeof startSync>>,
	ac: AbortController,
	child: FakeChild,
): Promise<void> {
	if (result.ok) {
		ac.abort();
		child.emit("exit", 0);
		await result.handle.stop();
	}
}

async function waitForSpawnCount(n: number, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (spawnMock.mock.calls.length < n) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(
				`waitForSpawnCount(${n}): only ${spawnMock.mock.calls.length} after ${timeoutMs}ms`,
			);
		}
		await new Promise((r) => setTimeout(r, 5));
	}
}

beforeEach(() => {
	spawnMock.mockReset();
	process.env = { ...ORIGINAL_ENV };
	delete process.env.OBSIDIAN_EMAIL;
	delete process.env.OBSIDIAN_PASSWORD;
	delete process.env.OBSIDIAN_VAULT_NAME;
	delete process.env.OBSIDIAN_MFA;
	delete process.env.OBSIDIAN_E2EE_PASSWORD;
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe("readSyncEnv", () => {
	it("returns missing-env error when required vars are absent", () => {
		const result = readSyncEnv({});
		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "missing-env") {
			expect(result.error.vars).toEqual([
				"OBSIDIAN_EMAIL",
				"OBSIDIAN_PASSWORD",
				"OBSIDIAN_VAULT_NAME",
			]);
		}
	});

	it("includes only the missing var names", () => {
		const result = readSyncEnv({ OBSIDIAN_EMAIL: "a@b.c" });
		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "missing-env") {
			expect(result.error.vars).toEqual([
				"OBSIDIAN_PASSWORD",
				"OBSIDIAN_VAULT_NAME",
			]);
		}
	});

	it("returns full env value with optional fields when set", () => {
		const result = readSyncEnv({
			OBSIDIAN_EMAIL: "a@b.c",
			OBSIDIAN_PASSWORD: "pw",
			OBSIDIAN_VAULT_NAME: "MyVault",
			OBSIDIAN_MFA: "123456",
			OBSIDIAN_E2EE_PASSWORD: "secret",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				email: "a@b.c",
				password: "pw",
				vaultName: "MyVault",
				mfa: "123456",
				e2eePassword: "secret",
			});
		}
	});

	it("omits optional fields when unset", () => {
		const result = readSyncEnv({
			OBSIDIAN_EMAIL: "a@b.c",
			OBSIDIAN_PASSWORD: "pw",
			OBSIDIAN_VAULT_NAME: "MyVault",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.mfa).toBeUndefined();
			expect(result.value.e2eePassword).toBeUndefined();
		}
	});
});

describe("startSync: env validation", () => {
	it("propagates missing-env error without touching child_process", async () => {
		const tmp = makeTmpDir();
		const result = await startSync({
			vaultRoot: tmp,
			configDir: path.join(tmp, "cfg"),
			signal: new AbortController().signal,
			shutdownTimeoutMs: 100,
			fileTypes: ["image", "audio", "video", "pdf", "unsupported"],
			backoff: { initialMs: 1, maxMs: 10, resetAfterUpMs: 1000 },
			firstSync: { quietMs: 5, timeoutMs: 200 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("missing-env");
		expect(spawnMock).not.toHaveBeenCalled();
		rmTmpDir(tmp);
	});
});

describe("hydrateInitialVault", () => {
	it("sets mirror-remote mode and runs a one-shot sync before startup writes", async () => {
		const tmp = makeTmpDir();
		const configDir = path.join(tmp, "cfg");
		markSyncReady(configDir);
		setValidSyncEnv();

		const modeChild = makeFakeChild();
		const syncChild = makeFakeChild();
		spawnMock.mockReturnValueOnce(modeChild).mockReturnValueOnce(syncChild);

		const p = hydrateInitialVault(
			startOptions(tmp, configDir, new AbortController().signal),
		);
		await waitForSpawnCount(1);
		modeChild.emit("exit", 0);
		await waitForSpawnCount(2);
		syncChild.emit("exit", 0);

		const result = await p;
		expect(result.ok).toBe(true);
		expect(spawnMock).toHaveBeenCalledTimes(2);

		const modeCall = spawnMock.mock.calls[0] as unknown[];
		expect(modeCall[1]).toEqual([
			"sync-config",
			"--path",
			tmp,
			"--mode",
			"mirror-remote",
			"--file-types",
			"image,audio,video,pdf,unsupported",
		]);
		const syncCall = spawnMock.mock.calls[1] as unknown[];
		expect(syncCall[1]).toEqual(["sync", "--path", tmp]);

		rmTmpDir(tmp);
	});
});

describe("startSync: first-time setup + continuous spawn", () => {
	it("runs login + sync-setup, then spawns continuous child with correct args", async () => {
		const tmp = makeTmpDir();
		const configDir = path.join(tmp, "cfg");
		setValidSyncEnv();

		const { loginChild, setupChild, modeChild, continuousChild } =
			queueFirstRunChildren();

		const ac = new AbortController();
		const startPromise = startSync(startOptions(tmp, configDir, ac.signal));
		const result = await finishFirstRun(
			loginChild,
			setupChild,
			modeChild,
			continuousChild,
			startPromise,
		);
		expect(result.ok).toBe(true);

		// Spawn calls: 0 = login, 1 = sync-setup, 2 = sync-config, 3 = continuous.
		expect(spawnMock).toHaveBeenCalledTimes(4);
		const calls = spawnMock.mock.calls as unknown[][];
		const loginCall = calls[0] ?? [];
		expect(loginCall[0]).toBe("ob");
		expect(loginCall[1]).toEqual([
			"login",
			"--email",
			"a@b.c",
			"--password",
			"pw",
		]);
		expect(loginCall[2]).toMatchObject({
			env: expect.objectContaining({ HOME: configDir }),
		});
		const setupCall = calls[1] ?? [];
		expect(setupCall[1]).toEqual([
			"sync-setup",
			"--vault",
			"MyVault",
			"--path",
			tmp,
		]);
		const modeCall = calls[2] ?? [];
		expect(modeCall[1]).toEqual([
			"sync-config",
			"--path",
			tmp,
			"--mode",
			"bidirectional",
			"--file-types",
			"image,audio,video,pdf,unsupported",
		]);
		const continuousCall = calls[3] ?? [];
		expect(continuousCall[1]).toEqual(["sync", "--path", tmp, "--continuous"]);
		expect(continuousCall[2]).toMatchObject({
			cwd: tmp,
			env: expect.objectContaining({ HOME: configDir }),
		});

		// Marker file written.
		expect(existsSync(path.join(configDir, ".klaus-sync-ready"))).toBe(true);

		// Shutdown.
		if (result.ok) {
			ac.abort();
			expect(continuousChild.__signals).toContain("SIGTERM");
			continuousChild.emit("exit", 0);
			await result.handle.stop();
		}

		rmTmpDir(tmp);
	});

	it("appends --mfa when OBSIDIAN_MFA is set", async () => {
		const tmp = makeTmpDir();
		const configDir = path.join(tmp, "cfg");
		setValidSyncEnv({ OBSIDIAN_MFA: "123456" });

		const { loginChild, setupChild, modeChild, continuousChild } =
			queueFirstRunChildren();

		const ac = new AbortController();
		const p = startSync(startOptions(tmp, configDir, ac.signal));
		const result = await finishFirstRun(
			loginChild,
			setupChild,
			modeChild,
			continuousChild,
			p,
		);
		expect(result.ok).toBe(true);

		const firstCall = spawnMock.mock.calls[0] as unknown[];
		expect(firstCall[1]).toEqual([
			"login",
			"--email",
			"a@b.c",
			"--password",
			"pw",
			"--mfa",
			"123456",
		]);

		await stopStartedSync(result, ac, continuousChild);
		rmTmpDir(tmp);
	});

	it("passes E2EE password to sync-setup when set", async () => {
		const tmp = makeTmpDir();
		const configDir = path.join(tmp, "cfg");
		setValidSyncEnv({ OBSIDIAN_E2EE_PASSWORD: "encrypted" });

		const { loginChild, setupChild, modeChild, continuousChild } =
			queueFirstRunChildren();

		const ac = new AbortController();
		const p = startSync(startOptions(tmp, configDir, ac.signal));
		const result = await finishFirstRun(
			loginChild,
			setupChild,
			modeChild,
			continuousChild,
			p,
		);
		expect(result.ok).toBe(true);

		const setupCall = spawnMock.mock.calls[1] as unknown[];
		expect(setupCall[1]).toEqual([
			"sync-setup",
			"--vault",
			"MyVault",
			"--path",
			tmp,
			"--password",
			"encrypted",
		]);

		await stopStartedSync(result, ac, continuousChild);
		rmTmpDir(tmp);
	});

	it("returns setup-failed when login exits non-zero", async () => {
		const tmp = makeTmpDir();
		const configDir = path.join(tmp, "cfg");
		setValidSyncEnv();

		const loginChild = makeFakeChild();
		spawnMock.mockReturnValueOnce(loginChild);

		const ac = new AbortController();
		const p = startSync(startOptions(tmp, configDir, ac.signal));
		await waitForSpawnCount(1);
		loginChild.stderr.emit("data", "bad password");
		loginChild.emit("exit", 1);

		const result = await p;
		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "setup-failed") {
			expect(result.error.step).toBe("login");
			expect(result.error.exitCode).toBe(1);
			expect(result.error.stderr).toContain("bad password");
		}
		expect(spawnMock).toHaveBeenCalledTimes(1);
		rmTmpDir(tmp);
	});

	it("skips login + sync-setup when marker file exists", async () => {
		const tmp = makeTmpDir();
		const configDir = path.join(tmp, "cfg");
		markSyncReady(configDir);
		setValidSyncEnv();

		const modeChild = makeFakeChild();
		const continuousChild = makeFakeChild();
		spawnMock
			.mockReturnValueOnce(modeChild)
			.mockReturnValueOnce(continuousChild);

		const ac = new AbortController();
		const p = startSync(startOptions(tmp, configDir, ac.signal));
		await waitForSpawnCount(1);
		modeChild.emit("exit", 0);
		await waitForSpawnCount(2);
		continuousChild.stdout.emit("data", "watching\n");
		const result = await p;
		expect(result.ok).toBe(true);
		expect(spawnMock).toHaveBeenCalledTimes(2);
		const modeCall = spawnMock.mock.calls[0] as unknown[];
		expect(modeCall[1]).toEqual([
			"sync-config",
			"--path",
			tmp,
			"--mode",
			"bidirectional",
			"--file-types",
			"image,audio,video,pdf,unsupported",
		]);
		const continuousCall = spawnMock.mock.calls[1] as unknown[];
		expect(continuousCall[1]).toEqual(["sync", "--path", tmp, "--continuous"]);

		await stopStartedSync(result, ac, continuousChild);
		rmTmpDir(tmp);
	});
});

describe("startSync: crash + restart with backoff", () => {
	it("respawns continuous child after crash exit", async () => {
		const tmp = makeTmpDir();
		const configDir = path.join(tmp, "cfg");
		markSyncReady(configDir);
		setValidSyncEnv();

		const mode = makeFakeChild();
		const first = makeFakeChild();
		const second = makeFakeChild();
		spawnMock
			.mockReturnValueOnce(mode)
			.mockReturnValueOnce(first)
			.mockReturnValueOnce(second);

		const ac = new AbortController();
		const p = startSync(
			startOptions(tmp, configDir, ac.signal, 50, {
				initialMs: 1,
				maxMs: 5,
				resetAfterUpMs: 1000,
			}),
		);
		await waitForSpawnCount(1);
		mode.emit("exit", 0);
		await waitForSpawnCount(2);
		first.stdout.emit("data", "watching\n");
		const result = await p;
		expect(result.ok).toBe(true);

		// Crash the first child.
		first.emit("exit", 1);
		// Allow backoff sleep + respawn.
		await new Promise((r) => setTimeout(r, 20));
		expect(spawnMock).toHaveBeenCalledTimes(3);

		await stopStartedSync(result, ac, second);
		rmTmpDir(tmp);
	});
});

describe("startSync: shutdown signalling", () => {
	it("escalates to SIGKILL after shutdownTimeoutMs", async () => {
		const tmp = makeTmpDir();
		const configDir = path.join(tmp, "cfg");
		markSyncReady(configDir);
		setValidSyncEnv();

		const mode = makeFakeChild();
		const child = makeFakeChild();
		spawnMock.mockReturnValueOnce(mode).mockReturnValueOnce(child);

		const ac = new AbortController();
		const p = startSync(
			startOptions(tmp, configDir, ac.signal, 10, {
				initialMs: 1,
				maxMs: 5,
				resetAfterUpMs: 1000,
			}),
		);
		await waitForSpawnCount(1);
		mode.emit("exit", 0);
		await waitForSpawnCount(2);
		child.stdout.emit("data", "watching\n");
		const result = await p;
		expect(result.ok).toBe(true);

		ac.abort();
		expect(child.__signals).toContain("SIGTERM");
		await new Promise((r) => setTimeout(r, 30));
		expect(child.__signals).toContain("SIGKILL");

		// Drain the loop.
		child.emit("exit", null);
		if (result.ok) await result.handle.stop();
		rmTmpDir(tmp);
	});
});
