import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

// ---- Mocks for runAgent (must be set up before importing agent.ts) ----
const mockCallModel = mock(async () => ({
	content: "",
	usage: { promptTokens: 10, completionTokens: 5, costUsd: 0 },
	steps: [],
}));
mock.module("../../core/model-router", () => ({ callModel: mockCallModel }));

// Mock conversation store — buildConversationMessages reads from it
mock.module("@/store/conversation", () => ({
	getConversation: mock(async () => []),
	getTraces: mock(async () => new Map()),
	appendTrace: mock(async () => {}),
	appendMessage: mock(async () => "msg-id"),
	appendAck: mock(async () => {}),
	appendReaction: mock(async () => {}),
	findByExternalId: mock(() => null),
	resolveExternalId: mock(() => null),
	resolveMessageId: mock(() => null),
	rebuildIndexes: mock(async () => {}),
	_clearIndexesForTest: mock(() => {}),
}));

import { loadAgentDefinition, runAgent } from "@/core/agent";
import {
	registerTool,
	registerToolset,
	toolRegistry,
	toolsetRegistry,
} from "@/core/registry";
import { flagRegistry } from "@/core/flags";
import type { AssembledContext, TurnContext } from "@/types";

// ---- runAgent helpers ----

const emptyAssembled: AssembledContext = {
	vars: {},
	messageRefs: {},
	totalTokens: 0,
};

function makeTurn(
	vars: Record<string, unknown> = {},
	messageOverrides: Partial<import("@/types").InboundMessage> = {},
): TurnContext {
	return {
		chatId: "user@s.whatsapp.net",
		message: {
			kind: "whatsapp",
			id: "msg-1",
			chatId: "user@s.whatsapp.net",
			senderId: "user@s.whatsapp.net",
			text: "hello",
			timestamp: new Date(),
			messageKey: {},
			...messageOverrides,
		},
		agent: {
			name: "test",
			modelTier: "default",
			tools: [],
			promptPath: "/dev/null",
		},
		flags: {},
		assembled: { ...emptyAssembled, vars },
	};
}

async function writeAgentFile(promptPath: string, body: string): Promise<void> {
	await Bun.write(
		promptPath,
		`---\nname: test-agent\nmodelTier: default\ntools: []\n---\n${body}`,
	);
}

// Helper: write a minimal valid agent fixture and clean it up after the test.
async function withFixture(
	name: string,
	frontmatter: string,
	body: string,
	fn: (p: string) => Promise<void>,
): Promise<void> {
	const p = path.join(import.meta.dir, `__fixture-${name}.md`);
	await Bun.write(p, `---\n${frontmatter}\n---\n${body}`);
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
	// --- basic shape ---

	test("parses name and modelTier from frontmatter", async () => {
		await withFixture(
			"basic",
			"name: my-agent\nmodelTier: default\ntools: []",
			"## Hi\n",
			async (p) => {
				const def = await loadAgentDefinition(p);
				expect(def.name).toBe("my-agent");
				expect(def.modelTier).toBe("default");
			},
		);
	});

	test('parses "high" modelTier correctly', async () => {
		await withFixture(
			"high-tier",
			"name: deep-agent\nmodelTier: high\ntools: []",
			"## Hi\n",
			async (p) => {
				const def = await loadAgentDefinition(p);
				expect(def.modelTier).toBe("high");
			},
		);
	});

	test("promptPath is the absolute path passed in", async () => {
		await withFixture(
			"path",
			"name: path-agent\nmodelTier: default\ntools: []",
			"## Hi\n",
			async (p) => {
				const def = await loadAgentDefinition(p);
				expect(def.promptPath).toBe(p);
			},
		);
	});

	// --- tools ---

	test("tools are parsed as an array of strings", async () => {
		await withFixture(
			"tools",
			"name: tool-agent\nmodelTier: default\ntools: [alpha, beta]",
			"## Hi\n",
			async (p) => {
				const def = await loadAgentDefinition(p);
				expect(def.tools).toEqual(["alpha", "beta"]);
			},
		);
	});

	// --- schedule ---

	test("schedule string is parsed from frontmatter", async () => {
		const fm =
			'name: scheduled-agent\nmodelTier: default\ntools: []\nschedule: "0 3 * * *"';
		await withFixture("schedule", fm, "## Hi\n", async (p) => {
			const def = await loadAgentDefinition(p);
			expect(def.schedule).toBe("0 3 * * *");
		});
	});

	test("no schedule field when schedule key is absent", async () => {
		await withFixture(
			"no-schedule",
			"name: quiet-agent\nmodelTier: default\ntools: []",
			"## Hi\n",
			async (p) => {
				const def = await loadAgentDefinition(p);
				expect(def.schedule).toBeUndefined();
			},
		);
	});

	// --- conversationLimit ---

	test("conversationLimit is parsed from frontmatter", async () => {
		const fm =
			"name: limit-agent\nmodelTier: default\ntools: []\nconversationLimit: 10";
		await withFixture("conv-limit", fm, "## Hi\n", async (p) => {
			const def = await loadAgentDefinition(p);
			expect(def.conversationLimit).toBe(10);
		});
	});

	test("missing conversationLimit produces no property", async () => {
		await withFixture(
			"no-conv-limit",
			"name: plain-agent\nmodelTier: default\ntools: []",
			"## Hi\n",
			async (p) => {
				const def = await loadAgentDefinition(p);
				expect(def.conversationLimit).toBeUndefined();
			},
		);
	});

	// --- toolsets ---

	test("toolsets: YAML key is parsed into toolsets array", async () => {
		const fm =
			"name: ts-agent\nmodelTier: default\ntools: []\ntoolsets: [vault, files]";
		await withFixture("toolsets", fm, "## Hi\n", async (p) => {
			const def = await loadAgentDefinition(p);
			expect(def.toolsets).toEqual(["vault", "files"]);
		});
	});

	test("missing toolsets produces no toolsets property", async () => {
		await withFixture(
			"no-toolsets",
			"name: plain-agent\nmodelTier: default\ntools: []",
			"## Hi\n",
			async (p) => {
				const def = await loadAgentDefinition(p);
				expect(def.toolsets).toBeUndefined();
			},
		);
	});

	// --- skills ---

	test("skills: YAML key is parsed into skills array", async () => {
		const fm =
			"name: skill-agent\nmodelTier: default\ntools: []\nskills: [workout, meal]";
		await withFixture("skills", fm, "## Hi\n", async (p) => {
			const def = await loadAgentDefinition(p);
			expect(def.skills).toEqual(["workout", "meal"]);
		});
	});

	test("missing skills produces no skills property", async () => {
		await withFixture(
			"no-skills",
			"name: plain-agent\nmodelTier: default\ntools: []",
			"## Hi\n",
			async (p) => {
				const def = await loadAgentDefinition(p);
				expect(def.skills).toBeUndefined();
			},
		);
	});

	// --- unknown fields are ignored ---

	test("unknown frontmatter fields are silently ignored", async () => {
		const fm =
			"name: extra-agent\nmodelTier: default\ntools: []\nunknown_key: some_value";
		await withFixture("unknown-field", fm, "## Hi\n", async (p) => {
			const def = await loadAgentDefinition(p);
			expect(def.name).toBe("extra-agent");
		});
	});

	// --- error cases ---

	test("throws when file has no frontmatter", async () => {
		const tmpPath = path.join(import.meta.dir, "__no-frontmatter.md");
		await Bun.write(tmpPath, "# Just a heading\nNo frontmatter here.");
		try {
			await expect(loadAgentDefinition(tmpPath)).rejects.toThrow(
				"No YAML frontmatter",
			);
		} finally {
			unlinkSync(tmpPath);
		}
	});

	test("throws when modelTier is invalid", async () => {
		const tmpPath = path.join(import.meta.dir, "__bad-tier.md");
		await Bun.write(
			tmpPath,
			"---\nname: bad\nmodelTier: nonexistent\ntools: []\n---\n## hi\n",
		);
		try {
			await expect(loadAgentDefinition(tmpPath)).rejects.toThrow("nonexistent");
		} finally {
			unlinkSync(tmpPath);
		}
	});
});

/** Extract the first argument of the most recent mock call. */
function lastArg(m: ReturnType<typeof mock>): unknown {
	const calls = m.mock.calls as unknown[][];
	return calls[calls.length - 1]?.[0];
}

// ---- runAgent tests ----

describe("runAgent", () => {
	const tmpPath = path.join(import.meta.dir, "__runagent-test.md");

	beforeEach(async () => {
		mockCallModel.mockClear();
		mockCallModel.mockImplementation(async () => ({
			content: "",
			usage: { promptTokens: 10, completionTokens: 5, costUsd: 0 },
			steps: [],
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
		expect(mockCallModel).toHaveBeenCalledTimes(1);
		const opts = lastArg(mockCallModel);
		expect((opts as { tier: string }).tier).toBe("default");
		expect((opts as { chatId: string }).chatId).toBe("user@s.whatsapp.net");
	});

	test("system prompt includes agent body", async () => {
		const turn = makeTurn();
		turn.agent.promptPath = tmpPath;
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mockCallModel);
		expect((opts as { system: string }).system).toContain(
			"You are a test agent.",
		);
	});

	test("messages array includes current user message", async () => {
		const turn = makeTurn({ message_text: "hello" });
		turn.agent.promptPath = tmpPath;
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mockCallModel) as {
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
		const opts = lastArg(mockCallModel) as {
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
		const opts = lastArg(mockCallModel) as {
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
		const opts = lastArg(mockCallModel) as {
			messages: Array<{ role: string; content: string }>;
		};
		const lastMsg = opts.messages[opts.messages.length - 1];
		expect(lastMsg?.content).toContain("Transcript of voice note.");
		expect(lastMsg?.content).toContain('Caption: "see this"');
	});

	test("user message includes flags", async () => {
		flagRegistry.set("voice", {
			name: "voice",
			description: "reply as voice",
			prompt: "Answer as a voice message!",
		});
		const turn = makeTurn({}, { text: "hello" });
		turn.flags = { voice: true };
		turn.agent.promptPath = tmpPath;
		await runAgent(turn, turn.agent);
		cleanup();
		flagRegistry.delete("voice");
		const opts = lastArg(mockCallModel) as {
			messages: Array<{ role: string; content: string }>;
		};
		const lastMsg = opts.messages[opts.messages.length - 1];
		expect(lastMsg?.content).toContain("Answer as a voice message!");
	});

	test("system prompt includes memory when present", async () => {
		const turn = makeTurn({ memory: "### Node Title\nsome body text" });
		turn.agent.promptPath = tmpPath;
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mockCallModel);
		expect((opts as { system: string }).system).toContain("### Node Title");
	});

	test("runAgent returns void", async () => {
		const turn = makeTurn();
		turn.agent.promptPath = tmpPath;
		const result = await runAgent(turn, turn.agent);
		cleanup();
		expect(result).toBeUndefined();
	});

	test("tools from registry are wired into callModel", async () => {
		const executeFn = mock(async () => "ok");
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
		const opts = lastArg(mockCallModel);
		expect((opts as { tools?: Record<string, unknown> }).tools).toBeDefined();
		expect(
			(opts as { tools: Record<string, unknown> }).tools["test-tool"],
		).toBeDefined();
	});

	test("toolsets use a meta-tool initially; toolset tools registered but not active", async () => {
		const executeFn = mock(async () => "ok");
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
		const opts = lastArg(mockCallModel) as {
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
		const { generateMetaTool } = await import("@/core/registry");
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
		const executeFn = mock(async () => "ok");
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

		const opts = lastArg(mockCallModel) as {
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
		const opts = lastArg(mockCallModel);
		expect((opts as { tools?: Record<string, unknown> }).tools).toBeUndefined();
	});

	test("dispatched agent uses objective as user message", async () => {
		const base = makeTurn();
		const turn: TurnContext = {
			chatId: base.chatId,
			agent: { ...base.agent, promptPath: tmpPath },
			flags: {},
			assembled: base.assembled,
			dispatchContext: {
				caller: "thinking",
				objective: "Research LLM patterns",
				mode: { kind: "async" },
			},
		};
		await runAgent(turn, turn.agent);
		cleanup();
		const opts = lastArg(mockCallModel) as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(opts.messages[0]?.content).toBe("Research LLM patterns");
	});

	// -- Handlebars rendering --

	test("nested {{#if}} blocks render correctly", async () => {
		const p = path.join(import.meta.dir, "__hbs-nested.md");
		await Bun.write(
			p,
			"---\nname: test-agent\nmodelTier: default\ntools: []\n---\n{{#if outer}}A{{#if inner}}B{{/if}}C{{/if}}",
		);
		const turn = makeTurn({ outer: true, inner: true });
		turn.agent.promptPath = p;
		await runAgent(turn, turn.agent);
		try {
			unlinkSync(p);
		} catch {
			/* gone */
		}
		expect((lastArg(mockCallModel) as { system: string }).system).toBe("ABC");
	});

	test('{{#if (eq x "val")}} renders when value matches', async () => {
		const p = path.join(import.meta.dir, "__hbs-eq.md");
		await Bun.write(
			p,
			'---\nname: test-agent\nmodelTier: default\ntools: []\n---\n{{#if (eq message_type "voice")}}voice!{{/if}}',
		);
		const turn = makeTurn({ message_type: "voice" });
		turn.agent.promptPath = p;
		await runAgent(turn, turn.agent);
		try {
			unlinkSync(p);
		} catch {
			/* gone */
		}
		expect((lastArg(mockCallModel) as { system: string }).system).toBe(
			"voice!",
		);
	});

	test('{{#if (eq x "val")}} is empty when value does not match', async () => {
		const p = path.join(import.meta.dir, "__hbs-eq-miss.md");
		await Bun.write(
			p,
			'---\nname: test-agent\nmodelTier: default\ntools: []\n---\n{{#if (eq message_type "voice")}}voice!{{/if}}',
		);
		const turn = makeTurn({ message_type: "text" });
		turn.agent.promptPath = p;
		await runAgent(turn, turn.agent);
		try {
			unlinkSync(p);
		} catch {
			/* gone */
		}
		expect((lastArg(mockCallModel) as { system: string }).system).toBe("");
	});

	test("{{#each items}} renders array values", async () => {
		const p = path.join(import.meta.dir, "__hbs-each.md");
		await Bun.write(
			p,
			"---\nname: test-agent\nmodelTier: default\ntools: []\n---\n{{#each items}}-{{this}}{{/each}}",
		);
		const turn = makeTurn({ items: ["a", "b", "c"] });
		turn.agent.promptPath = p;
		await runAgent(turn, turn.agent);
		try {
			unlinkSync(p);
		} catch {
			/* gone */
		}
		expect((lastArg(mockCallModel) as { system: string }).system).toBe(
			"-a-b-c",
		);
	});

	test("& in var value is not HTML-escaped", async () => {
		const p = path.join(import.meta.dir, "__hbs-escape.md");
		await Bun.write(
			p,
			"---\nname: test-agent\nmodelTier: default\ntools: []\n---\n{{val}}",
		);
		const turn = makeTurn({ val: "a & b" });
		turn.agent.promptPath = p;
		await runAgent(turn, turn.agent);
		try {
			unlinkSync(p);
		} catch {
			/* gone */
		}
		expect((lastArg(mockCallModel) as { system: string }).system).toBe("a & b");
	});
});
