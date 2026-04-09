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
		aliases: [],
		modelTier: "medium" as const,
		tools: [],
		toolsets: [],
		providerTools: [],
		skills: [],
		persistent: false,
		voiceMode: "auto" as const,
		acceptMode: "off" as const,
		showToolsInContext: true,
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

describe("snippetsQuery HBS compilation", () => {
	beforeEach(() => {
		mkdirSync(snippetsDir, { recursive: true });
		writeFileSync(path.join(klausDir, "user.md"), "User bio");
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("static snippet without HBS is unchanged", async () => {
		writeFileSync(path.join(snippetsDir, "plain.md"), "No templates here");

		const result = await snippetsQuery.run(dummyTurn);
		expect(result.vars?.plain).toBe("No templates here");
	});

	test("HBS conditional resolves with voiceMode auto", async () => {
		writeFileSync(
			path.join(snippetsDir, "comm.md"),
			"{{#if isVoiceOn}}voice{{else}}text{{/if}}",
		);

		const result = await snippetsQuery.run(dummyTurn);
		expect(result.vars?.comm).toBe("text");
	});

	test("HBS conditional resolves with voiceMode on", async () => {
		writeFileSync(
			path.join(snippetsDir, "comm.md"),
			"{{#if isVoiceOn}}voice{{else}}text{{/if}}",
		);

		const turn = {
			...dummyTurn,
			agent: { ...dummyTurn.agent, voiceMode: "on" as const },
		};
		const result = await snippetsQuery.run(turn);
		expect(result.vars?.comm).toBe("voice");
	});

	test("forceVoice flag sets isVoiceOn", async () => {
		writeFileSync(
			path.join(snippetsDir, "comm.md"),
			"{{#if isVoiceOn}}voice{{else}}text{{/if}}",
		);

		const turn = {
			...dummyTurn,
			overrides: { forceVoice: true },
		};
		const result = await snippetsQuery.run(turn);
		expect(result.vars?.comm).toBe("voice");
	});

	test("suppressVoice flag sets isVoiceOff", async () => {
		writeFileSync(
			path.join(snippetsDir, "comm.md"),
			"{{#if isVoiceOff}}suppressed{{else}}normal{{/if}}",
		);

		const turn = {
			...dummyTurn,
			overrides: { suppressVoice: true },
		};
		const result = await snippetsQuery.run(turn);
		expect(result.vars?.comm).toBe("suppressed");
	});

	test("acceptMode and provider are available", async () => {
		writeFileSync(
			path.join(snippetsDir, "info.md"),
			"accept={{acceptMode}} provider={{provider}}",
		);

		const turn = {
			...dummyTurn,
			agent: {
				...dummyTurn.agent,
				acceptMode: "on" as const,
				provider: "gemini",
			},
		};
		const result = await snippetsQuery.run(turn);
		expect(result.vars?.info).toBe("accept=on provider=gemini");
	});

	test("malformed HBS falls back to raw content", async () => {
		writeFileSync(path.join(snippetsDir, "broken.md"), "{{#if unclosed}}oops");

		const result = await snippetsQuery.run(dummyTurn);
		expect(result.vars?.broken).toBe("{{#if unclosed}}oops");
	});

	test("HBS in user.md is compiled", async () => {
		writeFileSync(path.join(klausDir, "user.md"), "User on {{provider}}");

		const turn = {
			...dummyTurn,
			agent: { ...dummyTurn.agent, provider: "claude" },
		};
		const result = await snippetsQuery.run(turn);
		expect(result.vars?.user).toBe("User on claude");
	});
});
