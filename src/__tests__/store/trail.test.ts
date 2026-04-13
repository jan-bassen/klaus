import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetForTest, _setForTest } from "@/core/settings-loader";
import { appendTrail, cleanupOldTrails, formatTrailEntry } from "@/store/trail";
import type { TurnLog } from "@/store/turn-log";

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

function makeTurnLog(overrides?: Partial<TurnLog>): TurnLog {
	return {
		chatId: "test-chat",
		agent: "klaus",
		createdAt: "2026-04-09T14:23:05.000Z",
		overrides: [],
		provider: "claude",
		model: "claude-sonnet-4-20250514",
		tier: "medium",
		contextTokens: 5000,
		conversationMessages: 10,
		steps: [],
		promptTokens: 847,
		completionTokens: 234,
		durationMs: 1200,
		...overrides,
	};
}

describe("formatTrailEntry", () => {
	test("formats a basic turn with reply", () => {
		const entry = makeTurnLog({
			rawText: "What's the weather?",
			replyContent: "It's sunny in Berlin!",
		});
		const result = formatTrailEntry(entry, "Europe/Berlin");

		expect(result).toContain("### 16:23:05");
		expect(result).toContain("klaus");
		expect(result).toContain("claude-sonnet-4-20250514 (medium)");
		expect(result).toContain("**In**: What's the weather?");
		expect(result).toContain("**Tokens**: 847→234");
		expect(result).toContain("**Duration**: 1.2s");
		expect(result).toContain("**Out**: It's sunny in Berlin!");
		expect(result).toStartWith("---");
	});

	test("formats error turn", () => {
		const entry = makeTurnLog({
			rawText: "Do something",
			error: "Rate limit exceeded",
		});
		const result = formatTrailEntry(entry, "UTC");

		expect(result).toContain("**Error**: Rate limit exceeded");
		expect(result).not.toContain("**Out**");
	});

	test("formats turn with tool calls", () => {
		const entry = makeTurnLog({
			rawText: "Search for Berlin",
			replyContent: "Found it!",
			steps: [
				{
					toolCalls: [
						{ toolName: "web_search", args: '{"q":"Berlin weather"}' },
					],
					toolResults: [{ toolName: "web_search", result: '{"temp":18}' }],
				},
			],
		});
		const result = formatTrailEntry(entry, "UTC");

		expect(result).toContain(
			'`web_search` → {"q":"Berlin weather"} → {"temp":18}',
		);
	});

	test("formats turn with overrides", () => {
		const entry = makeTurnLog({
			overrides: ["voice", "large"],
			replyContent: "Done",
		});
		const result = formatTrailEntry(entry, "UTC");

		expect(result).toContain("**overrides**: voice, large");
	});

	test("truncates long strings", () => {
		const longText = "a".repeat(500);
		const entry = makeTurnLog({ rawText: longText, replyContent: "ok" });
		const result = formatTrailEntry(entry, "UTC");

		const inLine = result.split("\n").find((l) => l.startsWith("**In**"));
		expect(inLine).toBeDefined();
		expect(inLine?.length).toBeLessThan(210);
	});

	test("formats turn with reasoning", () => {
		const entry = makeTurnLog({
			replyContent: "Done",
			steps: [
				{
					reasoning: "I need to think about this carefully",
					toolCalls: [],
					toolResults: [],
				},
			],
		});
		const result = formatTrailEntry(entry, "UTC");

		expect(result).toContain("> I need to think about this carefully");
	});

	test("handles turn with no input text", () => {
		const entry = makeTurnLog({ replyContent: "Scheduled run complete" });
		const result = formatTrailEntry(entry, "UTC");

		expect(result).not.toContain("**In**");
		expect(result).toContain("**Out**: Scheduled run complete");
	});
});

describe("appendTrail", () => {
	test("creates file with header on first call", async () => {
		const trailDir = join(tmpDir, "trail-create");
		process.env.VAULT_DIR = join(tmpDir, "trail-create-vault");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(process.env.VAULT_DIR, "Klaus"), { recursive: true });

		// Symlink the trail dir so config.vault.trailDir resolves correctly
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
			contextTokens: 100,
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
		const content = await Bun.file(
			join(process.env.VAULT_DIR, "Klaus", "trail", trailFile as string),
		).text();
		expect(content).toContain("# Trail ");
		expect(content).toContain("### ");
		expect(content).toContain("**Out**: Hello!");

		delete process.env.VAULT_DIR;
	});

	test("respects enabled: false", async () => {
		const trailDir = join(tmpDir, "trail-disabled");
		process.env.VAULT_DIR = join(tmpDir, "trail-disabled-vault");

		_setForTest({ trail: { enabled: false, retentionDays: 3 } });

		await appendTrail({
			chatId: "test",
			agent: "klaus",
			overrides: [],
			provider: "claude",
			model: "test",
			tier: "small",
			contextTokens: 0,
			conversationMessages: 0,
			steps: [],
			promptTokens: 0,
			completionTokens: 0,
			durationMs: 0,
		});

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
		// Should not throw
	});
});
