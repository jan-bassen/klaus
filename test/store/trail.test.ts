import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { _resetForTest, _setForTest } from "@/config/schema";
import { appendTrail, cleanupOldTrails } from "@/store/trail";

let tmpDir: string;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "trail-test-"));
});

afterAll(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
	_resetForTest();
});

describe("appendTrail", () => {
	test("creates file with header on first call", async () => {
		const trailDir = join(tmpDir, "trail-create");
		process.env.VAULT_DIR = join(tmpDir, "trail-create-vault");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(process.env.VAULT_DIR, "Klaus"), { recursive: true });

		const { symlink } = await import("node:fs/promises");
		await mkdir(trailDir, { recursive: true });
		try {
			await symlink(trailDir, join(process.env.VAULT_DIR, "Klaus", "trail"));
		} catch {
			// already exists
		}

		_setForTest({ trail: { enabled: true, retentionDays: 3 } });

		await appendTrail({
			chatId: "test",
			agent: "klaus",
			overrides: [],
			provider: "claude",
			model: "claude-sonnet-4",
			tier: "medium",
			conversationMessages: 1,
			steps: [],
			promptTokens: 50,
			completionTokens: 20,
			durationMs: 500,
			replyContent: "Hello!",
		});

		const files = await readdir(join(process.env.VAULT_DIR, "Klaus", "trail"));
		expect(files.length).toBeGreaterThanOrEqual(1);

		const trailFile = files.find((f) => f.startsWith("trail-"));
		expect(trailFile).toBeDefined();
		const content = await readFile(
			join(process.env.VAULT_DIR, "Klaus", "trail", trailFile as string),
			"utf-8",
		);
		expect(content).toContain("# Trail ");
		expect(content).toContain("### ");
		expect(content).toContain("**Out**: Hello!");

		delete process.env.VAULT_DIR;
	});

	test("respects enabled: false", async () => {
		process.env.VAULT_DIR = join(tmpDir, "trail-disabled-vault");

		_setForTest({ trail: { enabled: false, retentionDays: 3 } });

		await appendTrail({
			chatId: "test",
			agent: "klaus",
			overrides: [],
			provider: "claude",
			model: "test",
			tier: "small",
			conversationMessages: 0,
			steps: [],
			promptTokens: 0,
			completionTokens: 0,
			durationMs: 0,
		});

		const trailDir = join(tmpDir, "trail-disabled");
		let exists = false;
		try {
			await readdir(trailDir);
			exists = true;
		} catch {
			exists = false;
		}
		expect(exists).toBe(false);

		delete process.env.VAULT_DIR;
	});
});

describe("cleanupOldTrails", () => {
	test("removes files older than retention window", async () => {
		const dir = join(tmpDir, "cleanup-old");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dir, { recursive: true });

		await writeFile(join(dir, "trail-2026-04-05.md"), "old");
		await writeFile(join(dir, "trail-2026-04-06.md"), "borderline");
		await writeFile(join(dir, "trail-2026-04-08.md"), "recent");
		await writeFile(join(dir, "trail-2026-04-09.md"), "today");

		await cleanupOldTrails(dir, 3, "2026-04-09");

		const remaining = await readdir(dir);
		expect(remaining).toContain("trail-2026-04-08.md");
		expect(remaining).toContain("trail-2026-04-09.md");
		expect(remaining).toContain("trail-2026-04-06.md");
		expect(remaining).not.toContain("trail-2026-04-05.md");
	});

	test("preserves non-matching files", async () => {
		const dir = join(tmpDir, "cleanup-safe");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dir, { recursive: true });

		await writeFile(join(dir, "trail-2026-04-01.md"), "old");
		await writeFile(join(dir, "notes.md"), "keep me");

		await cleanupOldTrails(dir, 3, "2026-04-09");

		const remaining = await readdir(dir);
		expect(remaining).toContain("notes.md");
		expect(remaining).not.toContain("trail-2026-04-01.md");
	});

	test("handles empty directory", async () => {
		const dir = join(tmpDir, "cleanup-empty");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dir, { recursive: true });

		await cleanupOldTrails(dir, 3, "2026-04-09");

		const remaining = await readdir(dir);
		expect(remaining).toHaveLength(0);
	});

	test("handles non-existent directory", async () => {
		await cleanupOldTrails(join(tmpDir, "no-such-dir"), 3, "2026-04-09");
	});
});
