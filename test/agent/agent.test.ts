import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { z } from "zod";

// Ensure the runtime message.md template exists for tests
beforeAll(() => {
	const vaultDir = process.env.VAULT_DIR ?? path.join(process.cwd(), "vault");
	const klausDir = path.join(vaultDir, "Klaus");
	mkdirSync(klausDir, { recursive: true });
	writeFileSync(
		path.join(klausDir, "message.md"),
		[
			'{{#if (eq media.kind "voice")}}Transcript of voice note.{{#if media.voice.caption}} Caption: "{{media.voice.caption}}"{{/if}}',
			'{{else if (eq media.kind "image")}}Image',
			'{{else if (eq media.kind "doc")}}Attached: {{media.doc.name}} ({{media.doc.mime}}){{#if media.doc.text}}',
			"```",
			"{{media.doc.text}}",
			"```{{/if}}",
			"{{/if}}",
			"{{#if quotedText}}> Quoted: {{quotedText}}{{/if}}",
			"",
			"{{messageText}}",
		].join("\n"),
	);
});

// ---- Mocks for runAgent (must be set up before importing agent.ts) ----
const mocks = vi.hoisted(() => ({
	mockCallModel: vi.fn(async () => ({
		content: "",
		usage: { promptTokens: 10, completionTokens: 5 },
		steps: [],
		durationMs: 100,
	})),
	mockGetConversation: vi.fn(async () => []),
	mockGetTraces: vi.fn(async () => new Map()),
	mockAppendTrace: vi.fn(async () => {}),
	mockAppendMessage: vi.fn(async () => "msg-id"),
	mockAppendAck: vi.fn(async () => {}),
	mockAppendReaction: vi.fn(async () => {}),
	mockFindByExternalId: vi.fn(() => null),
	mockResolveExternalId: vi.fn(() => null),
	mockResolveMessageId: vi.fn(() => null),
	mockRebuildIndexes: vi.fn(async () => {}),
	mock_clearIndexesForTest: vi.fn(() => {}),
}));

vi.mock("@/agent/model", () => ({ callModel: mocks.mockCallModel }));

vi.mock("@/store/conversation", () => ({
	getConversation: mocks.mockGetConversation,
	getTraces: mocks.mockGetTraces,
	appendTrace: mocks.mockAppendTrace,
	appendMessage: mocks.mockAppendMessage,
	appendAck: mocks.mockAppendAck,
	appendReaction: mocks.mockAppendReaction,
	findByExternalId: mocks.mockFindByExternalId,
	resolveExternalId: mocks.mockResolveExternalId,
	resolveMessageId: mocks.mockResolveMessageId,
	rebuildIndexes: mocks.mockRebuildIndexes,
	_clearIndexesForTest: mocks.mock_clearIndexesForTest,
}));

import { loadAgentDefinition } from "@/agent";
import { runAgent } from "@/agent/runner";

import {
	registerTool,
	registerToolset,
	toolRegistry,
	toolsetRegistry,
} from "@/tools";
import type { TurnContext } from "@/types";

// ---- runAgent helpers ----

function deriveMediaVar(
	media: import("@/types").InboundMessage["media"],
): unknown {
	if (!media)
		return { kind: null, doc: null, image: null, voice: null, quoted: null };
	if (media.mimeType.startsWith("audio/")) {
		return {
			kind: "voice",
			doc: null,
			image: null,
			voice: {
				caption: media.voiceCaption ?? "",
				transcript: media.transcription ?? "",
			},
			quoted: null,
		};
	}
	if (media.mimeType.startsWith("image/")) {
		return {
			kind: "image",
			doc: null,
			image: { name: media.fileName ?? "", mime: media.mimeType },
			voice: null,
			quoted: null,
		};
	}
	return {
		kind: "doc",
		doc: {
			text: media.extractedText ?? "",
			name: media.fileName ?? "",
			mime: media.mimeType,
		},
		image: null,
		voice: null,
		quoted: null,
	};
}

function makeTurn(
	vars: Record<string, unknown> = {},
	messageOverrides: Partial<import("@/types").InboundMessage> = {},
): TurnContext {
	const message = {
		kind: "whatsapp" as const,
		id: "msg-1",
		chatId: "user@s.whatsapp.net",
		senderId: "user@s.whatsapp.net",
		text: "hello",
		timestamp: new Date(),
		messageKey: {},
		...messageOverrides,
	};
	return {
		chatId: "user@s.whatsapp.net",
		message,
		agent: {
			name: "test",
			aliases: [],
			modelTier: "medium",
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
		vars: { media: deriveMediaVar(message.media), ...vars },
	};
}

async function writeAgentFile(promptPath: string, body: string): Promise<void> {
	writeFileSync(
		promptPath,
		`---\nname: test-agent\nmodelTier: medium\ntools: []\n---\n${body}`,
		"utf-8",
	);
}

// Helper: write a minimal valid agent fixture and clean it up after the test.
async function withFixture(
	name: string,
	frontmatter: string,
	body: string,
	fn: (p: string) => Promise<void>,
): Promise<void> {
	const p = path.join(import.meta.dirname, `__fixture-${name}.md`);
	writeFileSync(p, `---\n${frontmatter}\n---\n${body}`, "utf-8");
	try {
		await fn(p);
	} finally {
		try {
			unlinkSync(p);
		} catch {
			/* already gone */
		}
	}
}

describe("loadAgentDefinition", () => {
	test("parses name, modelTier, and promptPath from frontmatter", async () => {
		await withFixture(
			"basic",
			"name: my-agent\nmodelTier: medium\ntools: []",
			"## Hi\n",
			async (p) => {
				const def = await loadAgentDefinition(p);
				expect(def.name).toBe("my-agent");
				expect(def.modelTier).toBe("medium");
				expect(def.promptPath).toBe(p);
			},
		);
	});

	test.each([
		[
			"large modelTier",
			"name: a\nmodelTier: large\ntools: []",
			"modelTier",
			"large",
		],
		[
			"tools array",
			"name: a\nmodelTier: medium\ntools: [alpha, beta]",
			"tools",
			["alpha", "beta"],
		],
		[
			"schedule string",
			'name: a\nmodelTier: medium\ntools: []\nschedule: "0 3 * * *"',
			"schedule",
			"0 3 * * *",
		],
		[
			"missing schedule",
			"name: a\nmodelTier: medium\ntools: []",
			"schedule",
			undefined,
		],
		[
			"conversationLimit",
			"name: a\nmodelTier: medium\ntools: []\nconversationLimit: 10",
			"conversationLimit",
			10,
		],
		[
			"missing conversationLimit",
			"name: a\nmodelTier: medium\ntools: []",
			"conversationLimit",
			undefined,
		],
		[
			"toolsets array",
			"name: a\nmodelTier: medium\ntools: []\ntoolsets: [vault, files]",
			"toolsets",
			["vault", "files"],
		],
		[
			"missing toolsets",
			"name: a\nmodelTier: medium\ntools: []",
			"toolsets",
			[],
		],
		[
			"skills array",
			"name: a\nmodelTier: medium\ntools: []\nskills: [workout, meal]",
			"skills",
			["workout", "meal"],
		],
		["missing skills", "name: a\nmodelTier: medium\ntools: []", "skills", []],
	] as [
		string,
		string,
		string,
		unknown,
	][])("parses %s", async (_label, fm, field, expected) => {
		await withFixture("param", fm, "## Hi\n", async (p) => {
			const def = await loadAgentDefinition(p);
			const val = (def as Record<string, unknown>)[field];
			if (expected === undefined) expect(val).toBeUndefined();
			else expect(val).toEqual(expected);
		});
	});

	test("unknown frontmatter fields are silently ignored", async () => {
		const fm =
			"name: extra-agent\nmodelTier: medium\ntools: []\nunknown_key: some_value";
		await withFixture("unknown-field", fm, "## Hi\n", async (p) => {
			const def = await loadAgentDefinition(p);
			expect(def.name).toBe("extra-agent");
		});
	});

	// --- error cases ---

	test("throws when file has no frontmatter", async () => {
		const tmpPath = path.join(import.meta.dirname, "__no-frontmatter.md");
		writeFileSync(tmpPath, "# Just a heading\nNo frontmatter here.", "utf-8");
		try {
			await expect(loadAgentDefinition(tmpPath)).rejects.toThrow(
				"No YAML frontmatter",
			);
		} finally {
			unlinkSync(tmpPath);
		}
	});

	test("throws when modelTier is invalid", async () => {
		const tmpPath = path.join(import.meta.dirname, "__bad-tier.md");
		writeFileSync(
			tmpPath,
			"---\nname: bad\nmodelTier: nonexistent\ntools: []\n---\n## hi\n",
			"utf-8",
		);
		try {
			await expect(loadAgentDefinition(tmpPath)).rejects.toThrow("nonexistent");
		} finally {
			unlinkSync(tmpPath);
		}
	});
});

/** Extract the first argument of the most recent mock call. */
function lastArg(m: ReturnType<typeof vi.fn>): unknown {
	const calls = m.mock.calls as unknown[][];
	return calls[calls.length - 1]?.[0];
}

// ---- runAgent tests ----

describe("runAgent", () => {
	const tmpPath = path.join(import.meta.dirname, "__runagent-test.md");

	beforeEach(async () => {
		mocks.mockCallModel.mockClear();
		mocks.mockCallModel.mockImplementation(async () => ({
			content: "",
			usage: { promptTokens: 10, completionTokens: 5 },
			steps: [],
			durationMs: 100,
		}));
		await writeAgentFile(
			tmpPath,
			"## Instructions\nYou are a test agent.\n\n{{memory}}\n\n{{active_tasks}}\n\n{{flags}}",
		);
	});

	afterEach(() => {
		toolRegistry.clear();
		toolsetRegistry.clear();
	});

	const cleanup = () => {
		try {
			unlinkSync(tmpPath);
		} catch {
			/* already gone */
		}
	};

	test("calls callModel with correct tier and chatId", async () => {
		const turn = makeTurn();
		turn.agent.promptPath = tmpPath;
		await runAgent(turn, turn.agent);
		cleanup();
		expect(mocks.mockCallModel).toHaveBeenCalledTimes(1);
		const opts = lastArg(mocks.mockCallModel);
		expect((opts as { tier: string }).tier).toBe("medium");
		expect((opts as { chatId: string }).chatId).toBe("user@s.whatsapp.net");
	});

	test("system prompt includes agent body", async () => {
		const turn = makeTurn();
		turn.agent.promptPath = tmpPath;
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mocks.mockCallModel);
		expect((opts as { system: string }).system).toContain(
			"You are a test agent.",
		);
	});

	test("messages array includes current user message", async () => {
		const turn = makeTurn({ message_text: "hello" });
		turn.agent.promptPath = tmpPath;
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mocks.mockCallModel) as {
			messages: Array<{ role: string; content: string }>;
			system: string;
		};
		// Messages array should have at least the current message
		const lastMsg = opts.messages[opts.messages.length - 1];
		expect(lastMsg?.role).toBe("user");
		expect(lastMsg?.content).toContain("hello");
	});

	test("user message includes message text from turn.message", async () => {
		const turn = makeTurn({}, { text: "hello" });
		turn.agent.promptPath = tmpPath;
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mocks.mockCallModel) as {
			messages: Array<{ role: string; content: string }>;
		};
		const lastMsg = opts.messages[opts.messages.length - 1];
		expect(lastMsg?.content).toContain("hello");
	});

	test("user message includes quoted text when replying", async () => {
		const turn = makeTurn(
			{},
			{
				text: "my reply",
				quotedMessage: { externalId: "ext-q", text: "original message" },
			},
		);
		turn.agent.promptPath = tmpPath;
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mocks.mockCallModel) as {
			messages: Array<{ role: string; content: string }>;
		};
		const lastMsg = opts.messages[opts.messages.length - 1];
		expect(lastMsg?.content).toContain("> Quoted: original message");
		expect(lastMsg?.content).toContain("my reply");
	});

	test("user message includes voice note prefix", async () => {
		const turn = makeTurn(
			{},
			{
				media: {
					fileId: "f-1",
					path: "/tmp/audio.ogg",
					mimeType: "audio/ogg",
					transcription: "transcribed text",
					voiceCaption: "see this",
				},
			},
		);
		turn.agent.promptPath = tmpPath;
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mocks.mockCallModel) as {
			messages: Array<{ role: string; content: string }>;
		};
		const lastMsg = opts.messages[opts.messages.length - 1];
		expect(lastMsg?.content).toContain("Transcript of voice note.");
		expect(lastMsg?.content).toContain('Caption: "see this"');
	});

	test("flags do not inject prompt text into user message", async () => {
		const turn = makeTurn({}, { text: "hello" });
		turn.overrides = { voice: true };
		turn.agent.promptPath = tmpPath;
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mocks.mockCallModel) as {
			messages: Array<{ role: string; content: string }>;
		};
		const lastMsg = opts.messages[opts.messages.length - 1];
		// Flags are programmatic overrides now — no prompt text injected
		expect(lastMsg?.content).toBe("hello");
	});

	test("system prompt includes memory when present", async () => {
		const turn = makeTurn({ memory: "### Node Title\nsome body text" });
		turn.agent.promptPath = tmpPath;
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mocks.mockCallModel);
		expect((opts as { system: string }).system).toContain("### Node Title");
	});

	test("runAgent returns AgentRunResult", async () => {
		const turn = makeTurn();
		turn.agent.promptPath = tmpPath;
		const result = await runAgent(turn, turn.agent);
		cleanup();
		expect(result).toBeDefined();
		expect(typeof result.durationMs).toBe("number");
		expect(result.usage).toBeDefined();
		expect(Array.isArray(result.steps)).toBe(true);
		expect(typeof result.model).toBe("string");
		expect(typeof result.provider).toBe("string");
		expect(typeof result.tier).toBe("string");
		expect(typeof result.conversationMessages).toBe("number");
	});

	test("tools from registry are wired into callModel", async () => {
		const executeFn = vi.fn(async () => "ok");
		registerTool({
			name: "test-tool",
			description: "A test tool",
			inputSchema: z.object({ msg: z.string() }),
			execute: executeFn,
			kind: "builtin",
			capability: "tool",
		});
		const turn = makeTurn();
		turn.agent = { ...turn.agent, tools: ["test-tool"], promptPath: tmpPath };
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mocks.mockCallModel);
		expect((opts as { tools?: Record<string, unknown> }).tools).toBeDefined();
		expect(
			(opts as { tools: Record<string, unknown> }).tools["test-tool"],
		).toBeDefined();
	});

	test("toolsets use a meta-tool initially; toolset tools registered but not active", async () => {
		const executeFn = vi.fn(async () => "ok");
		registerToolset({
			name: "ts",
			description: "Test toolset.",
			tools: [
				{
					name: "ts.alpha",
					description: "A toolset tool",
					inputSchema: z.object({ x: z.string() }),
					execute: executeFn,
					kind: "builtin",
					capability: "tool",
				},
			],
		});
		const turn = makeTurn();
		turn.agent = { ...turn.agent, toolsets: ["ts"], promptPath: tmpPath };
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mocks.mockCallModel) as {
			tools?: Record<string, unknown>;
			activeTools?: string[];
		};
		// All tools (meta + toolset tools) are registered
		expect(opts.tools).toBeDefined();
		expect(opts.tools?.use_ts).toBeDefined();
		expect(opts.tools?.ts_alpha).toBeDefined();
		// Only the meta-tool is initially active; toolset tool is inactive until use_ts is called
		expect(opts.activeTools).toContain("use_ts");
		expect(opts.activeTools).not.toContain("ts_alpha");
	});

	test("generateMetaTool description lists all toolset tools", async () => {
		const { generateMetaTool } = await import("@/tools");
		const ts = {
			name: "demo",
			description: "Use for demo things.",
			tools: [
				{
					name: "demo.foo",
					description: "Foo action",
					inputSchema: z.object({}),
					execute: async () => {},
					kind: "builtin" as const,
					capability: "tool" as const,
				},
				{
					name: "demo.bar",
					description: "Bar action",
					inputSchema: z.object({}),
					execute: async () => {},
					kind: "builtin" as const,
					capability: "tool" as const,
				},
			],
		};
		const meta = generateMetaTool(ts);
		expect(meta.name).toBe("use_demo");
		expect(meta.description).toContain("demo.foo");
		expect(meta.description).toContain("Foo action");
		expect(meta.description).toContain("demo.bar");
		expect(meta.description).toContain("Bar action");
		expect(meta.description).toContain("Use for demo things.");
	});

	test("prepareStep expands activeTools after use_X call in a previous step", async () => {
		const executeFn = vi.fn(async () => "ok");
		registerToolset({
			name: "expand",
			description: "Expansion toolset.",
			tools: [
				{
					name: "expand.one",
					description: "One",
					inputSchema: z.object({}),
					execute: executeFn,
					kind: "builtin",
					capability: "tool",
				},
			],
		});
		const turn = makeTurn();
		turn.agent = { ...turn.agent, toolsets: ["expand"], promptPath: tmpPath };
		await runAgent(turn, turn.agent);
		cleanup();

		const opts = lastArg(mocks.mockCallModel) as {
			activeTools?: string[];
			prepareStep?: (
				steps: { toolCalls: { toolName: string }[]; toolResults: unknown[] }[],
			) => string[];
		};
		expect(opts.prepareStep).toBeDefined();

		// Before any use_expand call: same as initialActive
		const before = opts.prepareStep?.([]);
		expect(before).toContain("use_expand");
		expect(before).not.toContain("expand_one");

		// After a step that called use_expand: meta-tool removed, real tools added
		const after = opts.prepareStep?.([
			{ toolCalls: [{ toolName: "use_expand" }], toolResults: [] },
		]);
		expect(after).not.toContain("use_expand");
		expect(after).toContain("expand_one");
	});

	test("unknown tools are silently omitted from callModel", async () => {
		const turn = makeTurn();
		turn.agent = {
			...turn.agent,
			tools: ["nonexistent-tool"],
			promptPath: tmpPath,
		};
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mocks.mockCallModel);
		expect((opts as { tools?: Record<string, unknown> }).tools).toBeUndefined();
	});

	test.each([
		["cold", { temperaturePreset: "cold" }, "temperature", 0],
		["hot", { temperaturePreset: "hot" }, "temperature", 1],
		["creative", { topPPreset: "creative" }, "topP", 0.95],
		["rigid", { topPPreset: "rigid" }, "topP", 0.1],
	] as const)("%s preset resolves correctly", async (_label, overrides, key, expected) => {
		const turn = makeTurn();
		turn.agent.promptPath = tmpPath;
		turn.config = overrides;
		await runAgent(turn, turn.agent);
		cleanup();
		expect((lastArg(mocks.mockCallModel) as Record<string, unknown>)[key]).toBe(
			expected,
		);
	});

	test("no preset leaves temperature and topP undefined", async () => {
		const turn = makeTurn();
		turn.agent.promptPath = tmpPath;
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mocks.mockCallModel) as {
			temperature?: number;
			topP?: number;
		};
		expect(opts.temperature).toBeUndefined();
		expect(opts.topP).toBeUndefined();
	});

	test("dispatched agent uses objective as user message", async () => {
		const base = makeTurn();
		const turn: TurnContext = {
			chatId: base.chatId,
			agent: { ...base.agent, promptPath: tmpPath },
			overrides: {},
			config: {},
			messageRefs: {},
			vars: base.vars,
			dispatchContext: {
				caller: "thinking",
				objective: "Research LLM patterns",
				mode: { kind: "async" },
			},
		};
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mocks.mockCallModel) as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(opts.messages[0]?.content).toBe("Research LLM patterns");
	});
});
