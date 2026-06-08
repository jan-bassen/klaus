import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { settings } from "../../src/infra/config.ts";
import {
	appendMessage,
	appendReaction,
	appendTrace,
} from "../../src/infra/store/history.ts";
import type { InboundMessage } from "../../src/infra/whatsapp/receive.ts";
import {
	type AgentDefinition,
	AgentSchema,
} from "../../src/pipeline/agents.ts";
import { assembleContext } from "../../src/pipeline/context.ts";
import type { TurnContext } from "../../src/pipeline/core.ts";
import {
	RETURN_RESULT_TOOL_NAME,
	SEND_IMAGE_TOOL_NAME,
	SEND_MESSAGE_TOOL_NAME,
	SET_REACTION_TOOL_NAME,
} from "../../src/primitives/tools/core.ts";
import {
	registerTool,
	type ToolDefinition,
} from "../../src/primitives/tools/index.ts";
import type { Variable } from "../../src/primitives/variables/index.ts";
import { initAllStores } from "../helpers/stores.ts";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.ts";
import { makeTurn } from "../helpers/turn.ts";

const valueSchema = z.object({ value: z.string().optional() });
const refSchema = z.object({
	messageLabel: z
		.number({
			error: "messageLabel must be an integer message label, not a string.",
		})
		.int({
			error: "messageLabel must be an integer message label, not a string.",
		}),
});
type ValueTool = ToolDefinition<typeof valueSchema>;

const coreToolNames = [
	SEND_MESSAGE_TOOL_NAME,
	SET_REACTION_TOOL_NAME,
	SEND_IMAGE_TOOL_NAME,
	RETURN_RESULT_TOOL_NAME,
];

describe("pipeline/context.assembleVariables", () => {
	let tmpDir: string;
	let originalTemplatesDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);
		originalTemplatesDir = settings.vault.templatesDir;
		writeTemplates(tmpDir);
	});

	afterEach(() => {
		settings.vault.templatesDir = originalTemplatesDir;
		rmTmpDir(tmpDir);
	});

	it("runs first-phase variables before after-phase variables", async () => {
		const seen: string[] = [];
		const variables: Variable[] = [
			{
				key: "slow",
				run: async () => {
					await pause(5);
					seen.push("slow");
					return "ready";
				},
			},
			{
				key: "fast",
				run: async () => {
					seen.push("fast");
					return "ready";
				},
			},
			{
				key: "after",
				after: true,
				run: async (turn) => {
					seen.push(
						`after:${String(turn.vars?.slow)}:${String(turn.vars?.fast)}`,
					);
					return "done";
				},
			},
		];

		const ctx = await assembleContext(baseTurn(tmpDir), makeAgent(tmpDir), {
			variables,
		});

		expect(ctx.vars).toEqual({ slow: "ready", fast: "ready", after: "done" });
		expect(seen.at(-1)).toBe("after:ready:ready");
	});

	it("keeps successful variables when another variable fails", async () => {
		const variables: Variable[] = [
			{ key: "ok", run: async () => ({ value: 1 }) },
			{
				key: "bad",
				run: async () => {
					throw new Error("variable exploded");
				},
			},
			{
				key: "after",
				after: true,
				run: async (turn) => Object.keys(turn.vars ?? {}).sort(),
			},
		];

		const ctx = await assembleContext(baseTurn(tmpDir), makeAgent(tmpDir), {
			variables,
		});

		expect(ctx.vars).toEqual({ ok: { value: 1 }, after: ["ok"] });
	});
});

describe("pipeline/context.assembleHistory", () => {
	let tmpDir: string;
	let originalTemplatesDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);
		originalTemplatesDir = settings.vault.templatesDir;
		writeTemplates(tmpDir);
	});

	afterEach(() => {
		settings.vault.templatesDir = originalTemplatesDir;
		rmTmpDir(tmpDir);
	});

	it("renders history with compact tool names, numbering both sides", async () => {
		await appendUser("u1", "First question");
		await appendTrace(
			"actual-run",
			"alpha",
			{ kind: "message", messageId: "u1" },
			[traceStep("probe", { ok: true })],
		);
		await appendAssistant("Alpha answer", "alpha", "actual-run");

		const def = makeAgent(tmpDir, "alpha");
		const turn = baseTurn(tmpDir, {
			agent: def,
			message: inbound("current", "Current question"),
			config: { historyLimit: 10 },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.history.messages).toEqual([
			{ role: "user", content: "ref #1\nFirst question" },
			{ role: "assistant", content: "ref #2 | tools probe\nAlpha answer" },
		]);
		expect(ctx.history.messageRefs).toEqual({
			"1": { externalId: "u1", role: "user" },
		});
	});

	it("omits tool summaries when showTools is false", async () => {
		await appendUser("u1", "First question");
		await appendTrace(
			"actual-run",
			"alpha",
			{ kind: "message", messageId: "u1" },
			[traceStep("probe", { ok: true })],
		);
		await appendAssistant("Alpha answer", "alpha", "actual-run");

		const def = makeAgent(tmpDir, "alpha");
		const turn = baseTurn(tmpDir, {
			agent: def,
			message: inbound("current", "Current question"),
			config: { historyLimit: 10, showTools: false },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.history.messages).toEqual([
			{ role: "user", content: "ref #1\nFirst question" },
			{ role: "assistant", content: "ref #2\nAlpha answer" },
		]);
	});

	it("drops empty assistant rows from replay (failed turns leave no transcript hole)", async () => {
		await appendUser("u1", "Question");
		await appendMessage({
			role: "assistant",
			agent: "alpha",
			runId: "failed-run",
			content: "",
			failed: true,
		});
		await appendUser("u2", "Follow-up");
		await appendAssistant("Real answer", "alpha", "ok-run");

		const def = makeAgent(tmpDir, "alpha");
		const turn = baseTurn(tmpDir, {
			agent: def,
			message: inbound("current", "Current question"),
			config: { historyLimit: 10 },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.history.messages).toEqual([
			{ role: "user", content: "ref #1\nQuestion" },
			{ role: "user", content: "ref #2\nFollow-up" },
			{ role: "assistant", content: "ref #3\nReal answer" },
		]);
	});

	it("filters agent-scoped history to user turns followed by that agent's reply", async () => {
		await appendUser("u-alpha", "Ask alpha");
		await appendAssistant("Alpha answer", "alpha", "run-alpha");
		await appendUser("u-beta", "Ask beta");
		await appendAssistant("Beta answer", "beta", "run-beta");

		const def = makeAgent(tmpDir, "alpha");
		const turn = baseTurn(tmpDir, {
			agent: def,
			message: inbound("current", "Current question"),
			config: { historyLimit: 10, historyScope: "agent" },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.history.messages).toEqual([
			{ role: "user", content: "ref #1\nAsk alpha" },
			{ role: "assistant", content: "ref #2\nAlpha answer" },
		]);
	});

	it("keeps a reaction-only agent turn visible on the user message", async () => {
		await appendUser("u-alpha", "Confirm this");
		await appendReaction({
			messageExternalId: "u-alpha",
			emoji: "✅",
			senderId: "bot",
			fromMe: true,
			agent: "alpha",
			runId: "run-alpha",
		});

		const def = makeAgent(tmpDir, "alpha");
		const turn = baseTurn(tmpDir, {
			agent: def,
			message: inbound("current", "Current question"),
			config: { historyLimit: 10, historyScope: "agent" },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.history.messages).toEqual([
			{
				role: "user",
				content: "ref #1 | reactions alpha ✅\nConfirm this",
			},
			{
				role: "assistant",
				content: "Handled ref #1 with reaction alpha ✅. No message was sent.",
			},
		]);
		expect(ctx.history.messageRefs).toEqual({
			"1": { externalId: "u-alpha", role: "user" },
		});
	});

	it("synthesizes handled context for full-scope reaction-only turns", async () => {
		await appendUser("u-alpha", "Looks good?");
		await appendReaction({
			messageExternalId: "u-alpha",
			emoji: "👍",
			senderId: "bot",
			fromMe: true,
			agent: "alpha",
			runId: "run-alpha",
		});

		const def = makeAgent(tmpDir, "alpha");
		const turn = baseTurn(tmpDir, {
			agent: def,
			message: inbound("current", "Current question"),
			config: { historyLimit: 10 },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.history.messages).toEqual([
			{
				role: "user",
				content: "ref #1 | reactions alpha 👍\nLooks good?",
			},
			{
				role: "assistant",
				content: "Handled ref #1 with reaction alpha 👍. No message was sent.",
			},
		]);
		expect(ctx.history.messageRefs).toEqual({
			"1": { externalId: "u-alpha", role: "user" },
		});
	});

	it("does not synthesize handled context when a real reply follows", async () => {
		await appendUser("u-alpha", "Confirm this");
		await appendReaction({
			messageExternalId: "u-alpha",
			emoji: "✅",
			senderId: "bot",
			fromMe: true,
			agent: "alpha",
			runId: "run-alpha",
		});
		await appendAssistant("Confirmed.", "alpha", "run-alpha");

		const def = makeAgent(tmpDir, "alpha");
		const turn = baseTurn(tmpDir, {
			agent: def,
			message: inbound("current", "Current question"),
			config: { historyLimit: 10 },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.history.messages).toEqual([
			{
				role: "user",
				content: "ref #1 | reactions alpha ✅\nConfirm this",
			},
			{ role: "assistant", content: "ref #2\nConfirmed." },
		]);
	});

	it("renders user reactions on assistant messages", async () => {
		await appendMessage({
			role: "assistant",
			agent: "alpha",
			runId: "run-alpha",
			content: "All set",
			externalId: "a-alpha",
		});
		await appendReaction({
			messageExternalId: "a-alpha",
			emoji: "❤️",
			senderId: "user",
			fromMe: false,
		});

		const def = makeAgent(tmpDir, "alpha");
		const turn = baseTurn(tmpDir, {
			agent: def,
			message: inbound("current", "Current question"),
			config: { historyLimit: 10 },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.history.messages).toEqual([
			{
				role: "assistant",
				content: "ref #1 | reactions user ❤️\nAll set",
			},
		]);
	});

	it("does not let reactions consume historyLimit slots", async () => {
		await appendUser("u1", "Old question");
		await appendReaction({
			messageExternalId: "u1",
			emoji: "👍",
			senderId: "bot",
			fromMe: true,
			agent: "alpha",
			runId: "run-react",
		});
		await appendUser("u2", "Recent question");
		await appendAssistant("Recent answer", "alpha", "run-recent");

		const def = makeAgent(tmpDir, "alpha");
		const turn = baseTurn(tmpDir, {
			agent: def,
			message: inbound("current", "Current question"),
			config: { historyLimit: 2 },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.history.messages).toEqual([
			{ role: "user", content: "ref #1\nRecent question" },
			{ role: "assistant", content: "ref #2\nRecent answer" },
		]);
	});

	it("applies historyLimit after excluding the current inbound message", async () => {
		await appendUser("u1", "Old question");
		await appendAssistant("Old answer", "alpha", "run-old");
		await appendUser("u2", "Recent question");
		await appendAssistant("Recent answer", "alpha", "run-recent");
		await appendUser("current", "Current question");

		const def = makeAgent(tmpDir, "alpha");
		const turn = baseTurn(tmpDir, {
			agent: def,
			message: inbound("current", "Current question"),
			config: { historyLimit: 2 },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.history.messages).toEqual([
			{ role: "user", content: "ref #1\nRecent question" },
			{ role: "assistant", content: "ref #2\nRecent answer" },
		]);
	});

	it("skipHistory returns no transcript and no message references", async () => {
		await appendUser("u1", "Past question");
		await appendAssistant("Past answer", "alpha", "run-alpha");

		const def = makeAgent(tmpDir, "alpha");
		const turn = baseTurn(tmpDir, {
			agent: def,
			message: inbound("current", "Current question"),
			config: { skipHistory: true },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.history).toEqual({ messages: [], messageRefs: {} });
		expect(turn.messageRefs).toEqual({});
	});

	it("skips malformed trace steps whose tool calls have no matching result", async () => {
		await appendUser("u1", "Question");
		await appendTrace(
			"orphan-run",
			"alpha",
			{ kind: "message", messageId: "u1" },
			[
				{
					toolCalls: [
						{
							toolCallId: "orphan-call",
							toolName: "probe",
							args: JSON.stringify({ value: "orphan" }),
						},
					],
					toolResults: [],
				},
			],
		);
		await appendAssistant("Answer survives", "alpha", "orphan-run");

		const def = makeAgent(tmpDir, "alpha");
		const turn = baseTurn(tmpDir, {
			agent: def,
			message: inbound("current", "Current question"),
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.history.messages).toEqual([
			{ role: "user", content: "ref #1\nQuestion" },
			{
				role: "assistant",
				content: "ref #2\nAnswer survives",
			},
		]);
	});

	it("lets history templates cap long message bodies", async () => {
		await appendUser("u1", "A".repeat(80));

		const def = makeAgent(tmpDir, "alpha");
		const turn = baseTurn(tmpDir, {
			agent: def,
			message: inbound("current", "Current question"),
			config: { historyLimit: 10 },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.history.messages).toEqual([
			{
				role: "user",
				content: `ref #1\n${"A".repeat(40)}...`,
			},
		]);
	});
});

describe("pipeline/context.invokeTool", () => {
	let tmpDir: string;
	let originalTemplatesDir: string;
	let pureExecute: ValueTool["execute"];
	let externalExecute: ValueTool["execute"];

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);
		originalTemplatesDir = settings.vault.templatesDir;
		writeTemplates(tmpDir);

		pureExecute = vi.fn<ValueTool["execute"]>(async (input) => ({
			real: "pure",
			input,
		}));
		externalExecute = vi.fn<ValueTool["execute"]>(async () => ({
			real: "external",
		}));

		registerTool(makeTool("pure_echo", pureExecute));
		registerTool(makeTool("external_send", externalExecute));
	});

	afterEach(() => {
		settings.vault.templatesDir = originalTemplatesDir;
		rmTmpDir(tmpDir);
	});

	it("passes through to real tool execution", async () => {
		const def = makeAgent(tmpDir, "alpha", ["pure_echo", "external_send"]);
		const turn = baseTurn(tmpDir, {
			agent: def,
			config: { skipHistory: true },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		await expect(
			ctx.tools.functionTools.pure_echo?.execute({ value: "p" }),
		).resolves.toEqual({
			real: "pure",
			input: { value: "p" },
		});
		await expect(
			ctx.tools.functionTools.external_send?.execute({ value: "e" }),
		).resolves.toEqual({
			real: "external",
		});

		expect(pureExecute).toHaveBeenCalledOnce();
		expect(externalExecute).toHaveBeenCalledOnce();
	});

	it("returns a tool error instead of executing invalid tool input", async () => {
		const def = makeAgent(tmpDir, "alpha", ["pure_echo"]);
		const turn = baseTurn(tmpDir, {
			agent: def,
			config: { skipHistory: true },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		const result = await ctx.tools.functionTools.pure_echo?.execute({
			value: 42,
		});

		expect(result).toEqual({
			error: expect.stringContaining("Invalid pure_echo input"),
		});
		expect(pureExecute).not.toHaveBeenCalled();
	});

	it("returns corrective schema messages for invalid tool input", async () => {
		const execute = vi.fn<ToolDefinition<typeof refSchema>["execute"]>(
			async () => "ok",
		);
		registerTool({
			name: "quote_probe",
			description: "Probe quote refs.",
			inputSchema: refSchema,
			execute,
		});
		const def = makeAgent(tmpDir, "alpha", ["quote_probe"]);
		const turn = baseTurn(tmpDir, {
			agent: def,
			config: { skipHistory: true },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		const result = await ctx.tools.functionTools.quote_probe?.execute({
			messageLabel: "3",
		});

		expect(result).toEqual({
			error: expect.stringContaining(
				"messageLabel: messageLabel must be an integer message label, not a string.",
			),
		});
		expect(execute).not.toHaveBeenCalled();
	});
});

describe("pipeline/context core tools", () => {
	let tmpDir: string;
	let originalTemplatesDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);
		originalTemplatesDir = settings.vault.templatesDir;
		writeTemplates(tmpDir);
		for (const name of coreToolNames) {
			registerTool(makeTool(name, async () => name));
		}
		registerTool(makeTool("pure_echo", async () => "pure"));
	});

	afterEach(() => {
		settings.vault.templatesDir = originalTemplatesDir;
		rmTmpDir(tmpDir);
	});

	it("adds message core tools and ignores frontmatter core tools", async () => {
		const def = makeAgent(tmpDir, "alpha", [
			"pure_echo",
			RETURN_RESULT_TOOL_NAME,
			SEND_MESSAGE_TOOL_NAME,
		]);
		const turn = baseTurn(tmpDir, {
			agent: def,
			config: { skipHistory: true },
			trigger: { kind: "message", messageId: "m1" },
		});

		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.tools.initialActive).toEqual([
			SEND_MESSAGE_TOOL_NAME,
			SET_REACTION_TOOL_NAME,
			SEND_IMAGE_TOOL_NAME,
			"pure_echo",
		]);
		expect(ctx.tools.initialActive).not.toContain(RETURN_RESULT_TOOL_NAME);
	});

	it("adds schedule and timer core tools without reactions", async () => {
		for (const trigger of [
			{ kind: "schedule" as const, scheduleId: "s1" },
			{ kind: "timer" as const, timerId: "t1" },
		]) {
			const def = makeAgent(tmpDir, `agent-${trigger.kind}`, ["pure_echo"]);
			const turn = baseTurn(tmpDir, {
				agent: def,
				config: { skipHistory: true },
				trigger,
			});

			const ctx = await assembleContext(turn, def, { variables: [] });

			expect(ctx.tools.initialActive).toEqual([
				SEND_MESSAGE_TOOL_NAME,
				SEND_IMAGE_TOOL_NAME,
				"pure_echo",
			]);
		}
	});

	it("adds only return_result for inline dispatch core tools", async () => {
		const def = makeAgent(tmpDir, "alpha", [
			"pure_echo",
			SEND_MESSAGE_TOOL_NAME,
			SET_REACTION_TOOL_NAME,
			SEND_IMAGE_TOOL_NAME,
		]);
		const turn = baseTurn(tmpDir, {
			agent: def,
			config: { skipHistory: true },
			trigger: { kind: "dispatch", parentRunId: "parent-1" },
		});

		const ctx = await assembleContext(turn, def, { variables: [] });

		expect(ctx.tools.initialActive).toEqual([
			RETURN_RESULT_TOOL_NAME,
			"pure_echo",
		]);
	});
});

function writeTemplates(tmpDir: string): void {
	settings.vault.templatesDir = path.join(tmpDir, "templates");
	mkdirSync(settings.vault.templatesDir, { recursive: true });
	writeFileSync(
		path.join(settings.vault.templatesDir, "message-user.md"),
		"{{label}}:{{messageText}}",
	);
	writeFileSync(
		path.join(settings.vault.templatesDir, "message-agent.md"),
		"{{label}}:{{message}}",
	);
	writeFileSync(
		path.join(settings.vault.templatesDir, "history-user.md"),
		'ref #{{label}}{{#if reactions}} | reactions {{reactions}}{{/if}}\n{{trunc messageText 40 suffix="..."}}',
	);
	writeFileSync(
		path.join(settings.vault.templatesDir, "history-agent.md"),
		'ref #{{label}}{{#if toolSummary}} | tools {{toolSummary}}{{/if}}{{#if reactions}} | reactions {{reactions}}{{/if}}\n{{trunc message 40 suffix="..."}}',
	);
}

function makeAgent(
	dir: string,
	name = "alpha",
	tools: string[] = [],
): AgentDefinition {
	const promptPath = path.join(dir, `${name}.md`);
	writeFileSync(promptPath, `---\nname: ${name}\n---\nYou are ${name}.`);
	const parsed = AgentSchema.parse({
		name,
		tools,
		report: false,
	});
	return { ...parsed, promptPath, prompt: { system: `You are ${name}.` } };
}

function baseTurn(
	tmpDir: string,
	patch: Partial<TurnContext> = {},
): TurnContext {
	const agent = patch.agent ?? makeAgent(tmpDir);
	return makeTurn({
		agent,
		config: { report: false, ...patch.config },
		message: patch.message ?? inbound("current", "Current question"),
		...patch,
	});
}

function inbound(id: string, text: string): InboundMessage {
	return {
		kind: "whatsapp",
		id,
		chatId: "c1",
		senderId: "sender",
		text,
		timestamp: new Date(),
		messageKey: {},
	};
}

async function appendUser(externalId: string, content: string): Promise<void> {
	await appendMessage({ role: "user", externalId, content });
}

async function appendAssistant(
	content: string,
	agent: string,
	runId: string,
): Promise<void> {
	await appendMessage({ role: "assistant", agent, runId, content });
}

function traceStep(toolName: string, result: unknown) {
	return {
		toolCalls: [
			{
				toolCallId: `${toolName}-call`,
				toolName,
				args: JSON.stringify({ value: toolName }),
			},
		],
		toolResults: [
			{
				toolCallId: `${toolName}-call`,
				toolName,
				result: typeof result === "string" ? result : JSON.stringify(result),
			},
		],
	};
}

function makeTool(
	name: string,
	execute: ToolDefinition<typeof valueSchema>["execute"],
): ToolDefinition<typeof valueSchema> {
	return {
		name,
		description: name,
		inputSchema: valueSchema,
		execute,
	};
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
