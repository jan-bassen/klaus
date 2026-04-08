import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Mock settings before importing the module under test
const testDir = path.join(tmpdir(), `klaus-snippets-test-${Date.now()}`);
const snippetsDir = path.join(testDir, "snippets");
const klausDir = testDir;

mock.module("@/settings", () => ({
	settings: {
		vault: {
			internalPath: klausDir,
			snippetsDir,
		},
	},
}));

const { snippetsQuery } = await import("@/context/snippets");

const dummyTurn = {
	chatId: "test@s.whatsapp.net",
	agent: {
		name: "test",
		modelTier: "medium" as const,
		tools: [],
		toolsets: [],
		providerTools: [],
		skills: [],
		persistent: false,
		promptPath: "/dev/null",
	},
	flags: {},
	overrides: {},
};

describe("snippetsQuery scope", () => {
	beforeEach(() => {
		mkdirSync(snippetsDir, { recursive: true });
		// Always need user.md in klausDir
		writeFileSync(path.join(klausDir, "user.md"), "User bio here");
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("no frontmatter defaults to system scope", async () => {
		writeFileSync(path.join(snippetsDir, "arch.md"), "Architecture content");

		const result = await snippetsQuery.run(dummyTurn);
		expect(result.vars?.arch).toBe("Architecture content");
		expect(result.userVars?.arch).toBeUndefined();
	});

	test("scope: system goes to vars only", async () => {
		writeFileSync(
			path.join(snippetsDir, "arch.md"),
			"---\nscope: system\n---\nSystem only content",
		);

		const result = await snippetsQuery.run(dummyTurn);
		expect(result.vars?.arch).toBe("System only content");
		expect(result.userVars?.arch).toBeUndefined();
	});

	test("scope: user goes to userVars only", async () => {
		writeFileSync(
			path.join(snippetsDir, "greeting.md"),
			"---\nscope: user\n---\nUser greeting",
		);

		const result = await snippetsQuery.run(dummyTurn);
		expect(result.vars?.greeting).toBeUndefined();
		expect(result.userVars?.greeting).toBe("User greeting");
	});

	test("scope: both goes to vars and userVars", async () => {
		writeFileSync(
			path.join(snippetsDir, "shared.md"),
			"---\nscope: both\n---\nShared content",
		);

		const result = await snippetsQuery.run(dummyTurn);
		expect(result.vars?.shared).toBe("Shared content");
		expect(result.userVars?.shared).toBe("Shared content");
	});

	test("invalid scope defaults to system", async () => {
		writeFileSync(
			path.join(snippetsDir, "bad.md"),
			"---\nscope: invalid\n---\nContent",
		);

		const result = await snippetsQuery.run(dummyTurn);
		expect(result.vars?.bad).toBe("Content");
		expect(result.userVars?.bad).toBeUndefined();
	});

	test("user.md always goes to system vars", async () => {
		const result = await snippetsQuery.run(dummyTurn);
		expect(result.vars?.user).toBe("User bio here");
	});

	test("userVars omitted when no user-scoped snippets exist", async () => {
		writeFileSync(path.join(snippetsDir, "arch.md"), "System content only");

		const result = await snippetsQuery.run(dummyTurn);
		expect(result.userVars).toBeUndefined();
	});
});
