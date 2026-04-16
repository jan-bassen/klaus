import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const testDir = path.join(tmpdir(), `klaus-snippets-test-${Date.now()}`);
const snippetsDir = path.join(testDir, "snippets");

vi.mock("@/config", () => ({
	settings: {
		vault: {
			internalPath: testDir,
			snippetsDir,
		},
	},
}));

const { snippetsVariable } = await import("@/variables/snippets");

const baseTurn = {
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
		showToolsInContext: true,
		promptPath: "/dev/null",
	},
	overrides: {},
	config: {},
	messageRefs: {},
	vars: {
		config: {
			provider: "default",
			isVoiceOn: false,
			isVoiceOff: false,
			isVoiceAuto: true,
		},
	},
};

describe("snippetsVariable", () => {
	beforeEach(() => {
		mkdirSync(snippetsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("static snippet passes through unchanged", async () => {
		writeFileSync(path.join(snippetsDir, "arch.md"), "Architecture content");
		const result = (await snippetsVariable.run(baseTurn)) as Record<
			string,
			string
		>;
		expect(result.arch).toBe("Architecture content");
	});

	test("HBS conditional resolves against assembled vars", async () => {
		writeFileSync(
			path.join(snippetsDir, "comm.md"),
			"{{#if config.isVoiceOn}}voice{{else}}text{{/if}}",
		);
		const result = (await snippetsVariable.run(baseTurn)) as Record<
			string,
			string
		>;
		expect(result.comm).toBe("text");
	});

	test("HBS resolves with forceVoice override", async () => {
		writeFileSync(
			path.join(snippetsDir, "comm.md"),
			"{{#if config.isVoiceOn}}voice{{else}}text{{/if}}",
		);
		const turn = {
			...baseTurn,
			vars: {
				config: {
					provider: "default",
					isVoiceOn: true,
					isVoiceOff: false,
					isVoiceAuto: false,
				},
			},
		};
		const result = (await snippetsVariable.run(turn)) as Record<string, string>;
		expect(result.comm).toBe("voice");
	});

	test("user.md in snippets/ is skipped (handled by user variable)", async () => {
		writeFileSync(path.join(snippetsDir, "user.md"), "User bio");
		writeFileSync(path.join(snippetsDir, "arch.md"), "Arch content");
		const result = (await snippetsVariable.run(baseTurn)) as Record<
			string,
			string
		>;
		expect(result.user).toBeUndefined();
		expect(result.arch).toBe("Arch content");
	});

	test("malformed HBS falls back to raw content", async () => {
		writeFileSync(path.join(snippetsDir, "broken.md"), "{{#if unclosed}}oops");
		const result = (await snippetsVariable.run(baseTurn)) as Record<
			string,
			string
		>;
		expect(result.broken).toBe("{{#if unclosed}}oops");
	});

	test("frontmatter is stripped", async () => {
		writeFileSync(
			path.join(snippetsDir, "meta.md"),
			"---\nsome: thing\n---\nBody only",
		);
		const result = (await snippetsVariable.run(baseTurn)) as Record<
			string,
			string
		>;
		expect(result.meta).toBe("Body only");
	});
});
