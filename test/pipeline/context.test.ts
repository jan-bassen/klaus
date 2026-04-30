import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { settings } from "../../src/infra/config.ts";
import { getOverlay } from "../../src/infra/simulation.ts";
import { appendMessage, appendTrace } from "../../src/infra/store/history.ts";
import type { InboundMessage } from "../../src/infra/whatsapp/receive.ts";
import {
	type AgentDefinition,
	AgentSchema,
} from "../../src/pipeline/agents.ts";
import { assembleContext } from "../../src/pipeline/context.ts";
import type { TurnContext } from "../../src/pipeline/core.ts";
import {
	registerTool,
	type ToolDefinition,
} from "../../src/primitives/tools/index.ts";
import type { Variable } from "../../src/primitives/variables/index.ts";
import { initAllStores } from "../helpers/stores.ts";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.ts";
import { makeTurn } from "../helpers/turn.ts";

const valueSchema = z.object({ value: z.string().optional() });
type ValueTool = ToolDefinition<typeof valueSchema>;

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

	it("renders chat-only history (no tool replay), numbering both sides", async () => {
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
			{ role: "user", content: "1:First question" },
			{ role: "assistant", content: "2:Alpha answer" },
		]);
		expect(ctx.history.messageRefs).toEqual({
			"1": { externalId: "u1", role: "user" },
		});
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
			{ role: "user", content: "1:Question" },
			{ role: "user", content: "2:Follow-up" },
			{ role: "assistant", content: "3:Real answer" },
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
			{ role: "user", content: "1:Ask alpha" },
			{ role: "assistant", content: "2:Alpha answer" },
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
			{ role: "user", content: "1:Recent question" },
			{ role: "assistant", content: "2:Recent answer" },
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
			{ role: "user", content: "1:Question" },
			{ role: "assistant", content: "2:Answer survives" },
		]);
	});
});

describe("pipeline/context.invokeTool simulation wrapper", () => {
	let tmpDir: string;
	let originalTemplatesDir: string;
	let pureExecute: ValueTool["execute"];
	let externalExecute: ValueTool["execute"];
	let statefulExecute: ValueTool["execute"];
	let simulatedExecute: ValueTool["execute"];
	let simulateHandler: NonNullable<ValueTool["simulate"]>;

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
		statefulExecute = vi.fn<ValueTool["execute"]>(async () => ({
			real: "stateful",
		}));
		simulatedExecute = vi.fn<ValueTool["execute"]>(async () => ({
			real: "simulated",
		}));
		simulateHandler = vi.fn<NonNullable<ValueTool["simulate"]>>(
			async (input) => ({ simulated: true, input }),
		);

		registerTool(makeTool("pure_echo", "pure", pureExecute));
		registerTool(makeTool("external_send", "external", externalExecute));
		registerTool(makeTool("stateful_write", "stateful", statefulExecute));
		registerTool(
			makeTool("custom_sim", "external", simulatedExecute, simulateHandler),
		);
	});

	afterEach(() => {
		settings.vault.templatesDir = originalTemplatesDir;
		rmTmpDir(tmpDir);
	});

	it("passes through to real tool execution outside simulation", async () => {
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

	it("passes pure tools through during simulation", async () => {
		const def = makeAgent(tmpDir, "alpha", ["pure_echo"]);
		const turn = baseTurn(tmpDir, {
			agent: def,
			config: { simulate: true, skipHistory: true },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		const result = await ctx.tools.functionTools.pure_echo?.execute({
			value: "p",
		});

		expect(result).toEqual({ real: "pure", input: { value: "p" } });
		expect(pureExecute).toHaveBeenCalledOnce();
		expect(getOverlay(turn as TurnContext).actions).toEqual([]);
	});

	it("fakes external tools during simulation and records the intended action", async () => {
		const def = makeAgent(tmpDir, "alpha", ["external_send"]);
		const turn = baseTurn(tmpDir, {
			agent: def,
			config: { simulate: true, skipHistory: true },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		const result = await ctx.tools.functionTools.external_send?.execute({
			value: "payload",
		});

		expect(result).toBe("ok");
		expect(externalExecute).not.toHaveBeenCalled();
		expect(getOverlay(turn as TurnContext).actions).toEqual([
			expect.objectContaining({
				tool: "external_send",
				sideEffect: "external",
				args: { value: "payload" },
				intent: "Would invoke external tool external_send",
				result: "ok",
			}),
		]);
	});

	it("fakes stateful tools during simulation and records the intended action", async () => {
		const def = makeAgent(tmpDir, "alpha", ["stateful_write"]);
		const turn = baseTurn(tmpDir, {
			agent: def,
			config: { simulate: true, skipHistory: true },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		const result = await ctx.tools.functionTools.stateful_write?.execute({
			value: "payload",
		});

		expect(result).toBe("(sim) stateful_write acknowledged");
		expect(statefulExecute).not.toHaveBeenCalled();
		expect(getOverlay(turn as TurnContext).actions).toEqual([
			expect.objectContaining({
				tool: "stateful_write",
				sideEffect: "stateful",
				args: { value: "payload" },
				intent: "Would stateful_write value=payload",
				result: "(sim) stateful_write acknowledged",
			}),
		]);
	});

	it("uses a tool's custom simulate handler before side-effect category routing", async () => {
		const def = makeAgent(tmpDir, "alpha", ["custom_sim"]);
		const turn = baseTurn(tmpDir, {
			agent: def,
			config: { simulate: true, skipHistory: true },
		});
		const ctx = await assembleContext(turn, def, { variables: [] });

		const result = await ctx.tools.functionTools.custom_sim?.execute({
			value: "payload",
		});

		expect(result).toEqual({ simulated: true, input: { value: "payload" } });
		expect(simulatedExecute).not.toHaveBeenCalled();
		expect(simulateHandler).toHaveBeenCalledOnce();
		expect(getOverlay(turn as TurnContext).actions).toEqual([
			expect.objectContaining({
				tool: "custom_sim",
				sideEffect: "external",
				args: { value: "payload" },
				intent: "Custom simulate handler",
				result: { simulated: true, input: { value: "payload" } },
			}),
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
	return { ...parsed, promptPath };
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
	sideEffect: ToolDefinition["sideEffect"],
	execute: ToolDefinition<typeof valueSchema>["execute"],
	simulate?: ToolDefinition<typeof valueSchema>["simulate"],
): ToolDefinition<typeof valueSchema> {
	return {
		name,
		description: name,
		inputSchema: valueSchema,
		execute,
		...(simulate ? { simulate } : {}),
		sideEffect,
		kind: "builtin",
		capability: "tool",
	};
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
