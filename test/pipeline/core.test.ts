import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { settings } from "../../src/infra/config.ts";
import { getTraces } from "../../src/infra/store/history.ts";
import { readReports } from "../../src/infra/store/report.ts";
import { listTimers, stopAllTimers } from "../../src/infra/store/timers.ts";
import {
	type AgentDefinition,
	AgentSchema,
} from "../../src/pipeline/agents.ts";
import { executeAgent, LlmTimeoutError } from "../../src/pipeline/core.ts";
import {
	registerTool,
	registerToolset,
	type ToolDefinition,
} from "../../src/primitives/tools/index.ts";
import { initAllStores } from "../helpers/stores.ts";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.ts";
import { makeTurn } from "../helpers/turn.ts";

const sendMock = vi.hoisted(() => vi.fn());
const replySchema = z.object({ content: z.string() });
const probeSchema = z.object({ value: z.string().optional() });
const hiddenSchema = z.object({});

vi.mock("@openrouter/sdk", () => ({
	OpenRouter: vi.fn(function OpenRouter() {
		return {
			chat: {
				send: sendMock,
			},
		};
	}),
}));

const replyTool: ToolDefinition<typeof replySchema> = {
	name: "reply",
	description: "Reply with text",
	inputSchema: replySchema,
	execute: async ({ content }) =>
		content === "not actually sent" ? { error: "not sent" } : "sent",
	kind: "builtin",
	capability: "tool",
};

const probeTool: ToolDefinition<typeof probeSchema> = {
	name: "probe",
	description: "Record a probe value",
	inputSchema: probeSchema,
	execute: async ({ value }) => ({ ok: true, value: value ?? "default" }),
	kind: "builtin",
	capability: "tool",
};

const hiddenTool: ToolDefinition<typeof hiddenSchema> = {
	name: "bundle_hidden",
	description: "Hidden toolset member",
	inputSchema: hiddenSchema,
	execute: async () => ({ ok: true }),
	kind: "builtin",
	capability: "tool",
};

describe("pipeline/core.executeAgent", () => {
	let tmpDir: string;
	let originalApiKey: string | undefined;
	let originalTemplatesDir: string;
	let originalAgent: typeof settings.agent;
	let originalPersistence: typeof settings.persistence;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);

		originalApiKey = process.env.OPENROUTER_API_KEY;
		originalTemplatesDir = settings.vault.templatesDir;
		originalAgent = structuredClone(settings.agent);
		originalPersistence = structuredClone(settings.persistence);

		process.env.OPENROUTER_API_KEY = "test-key";
		settings.vault.templatesDir = path.join(tmpDir, "templates");
		settings.agent.timeout = 1_000;
		settings.agent.retries.max = 1;
		settings.agent.retries.backoffMs = 0;
		settings.persistence.minNextRun = 1_000;
		settings.persistence.maxNextRun = 3_600_000;
		settings.persistence.defaultNextRun = "1h";

		mkdirSync(settings.vault.templatesDir, { recursive: true });
		writeFileSync(
			path.join(settings.vault.templatesDir, "message-user.md"),
			"{{messageText}}",
		);
		writeFileSync(
			path.join(settings.vault.templatesDir, "message-agent.md"),
			"{{message}}",
		);
		writeFileSync(
			path.join(settings.vault.templatesDir, "history-user.md"),
			"{{messageText}}",
		);
		writeFileSync(
			path.join(settings.vault.templatesDir, "history-agent.md"),
			"{{message}}",
		);
		writeFileSync(
			path.join(settings.vault.templatesDir, "persistence.md"),
			"{{prompt}}",
		);

		registerTool(replyTool);
		registerTool(probeTool);
		registerToolset({
			name: "bundle",
			description: "Grouped test tools",
			tools: [hiddenTool],
		});
	});

	afterEach(() => {
		stopAllTimers();
		settings.vault.templatesDir = originalTemplatesDir;
		Object.assign(settings.agent, originalAgent);
		Object.assign(settings.persistence, originalPersistence);
		if (originalApiKey === undefined) {
			delete process.env.OPENROUTER_API_KEY;
		} else {
			process.env.OPENROUTER_API_KEY = originalApiKey;
		}
		sendMock.mockReset();
		rmTmpDir(tmpDir);
	});

	it("runs tool-call steps, returns the transcript metadata, and accumulates usage", async () => {
		sendMock
			.mockResolvedValueOnce(
				chatResponse({
					toolCalls: [
						toolCall("reply", { content: "hello" }, "reply-1"),
						toolCall("probe", { value: "seen" }, "probe-1"),
					],
					reasoning: "use the available tools",
					usage: { promptTokens: 5, completionTokens: 7 },
					finishReason: "tool_calls",
				}),
			)
			.mockResolvedValueOnce(
				chatResponse({
					content: "done",
					usage: { promptTokens: 11, completionTokens: 13 },
					finishReason: "stop",
				}),
			);

		const def = makeAgent(tmpDir, { tools: ["reply", "probe"] });
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 2, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result).toMatchObject({
			model: "anthropic/claude-sonnet-4.6",
			tier: "medium",
			usage: { promptTokens: 16, completionTokens: 20 },
			systemPrompt: "You are core-test.",
			userMessage: "objective",
			historyMessages: [],
			replyContent: "hello",
		});
		expect(result.steps).toHaveLength(2);
		expect(result.steps[0]).toMatchObject({
			reasoning: "use the available tools",
			toolCalls: [
				{
					toolCallId: "reply-1",
					toolName: "reply",
					args: { content: "hello" },
				},
				{ toolCallId: "probe-1", toolName: "probe", args: { value: "seen" } },
			],
			toolResults: [
				{ toolCallId: "reply-1", toolName: "reply", result: "sent" },
				{
					toolCallId: "probe-1",
					toolName: "probe",
					result: { ok: true, value: "seen" },
				},
			],
		});
		expect(firstChatRequest()).toMatchObject({
			model: "anthropic/claude-sonnet-4.6",
			messages: [
				{ role: "system", content: "You are core-test." },
				{ role: "user", content: "objective" },
			],
		});
		expect(firstChatRequest().tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					function: expect.objectContaining({ name: "reply" }),
				}),
				expect.objectContaining({
					function: expect.objectContaining({ name: "probe" }),
				}),
			]),
		);
		expect(secondChatRequest().messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					toolCalls: expect.any(Array),
				}),
				expect.objectContaining({ role: "tool", toolCallId: "probe-1" }),
			]),
		);
	});

	it("joins reply tool calls and ignores non-reply calls when deriving replyContent", async () => {
		sendMock
			.mockResolvedValueOnce(
				chatResponse({
					toolCalls: [
						toolCall("reply", { content: "first" }, "reply-1"),
						toolCall("probe", { value: "ignored" }, "probe-1"),
						toolCall("reply", { content: "second" }, "reply-2"),
					],
				}),
			)
			.mockResolvedValueOnce(chatResponse());

		const def = makeAgent(tmpDir, { tools: ["reply", "probe"] });
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 2, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result.replyContent).toBe("first\n---\nsecond");
	});

	it("reports explicit tools and toolsets without flattening hidden toolset members", async () => {
		sendMock.mockResolvedValueOnce(chatResponse({ content: "done" }));

		const def = makeAgent(tmpDir, {
			tools: ["reply"],
			toolsets: ["bundle"],
		});
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result.context).toEqual({
			variables: [],
			tools: ["reply"],
			toolsets: ["bundle"],
			skills: [],
		});
	});

	it("derives replyContent from accepted reply tool calls only", async () => {
		sendMock
			.mockResolvedValueOnce(
				chatResponse({
					toolCalls: [
						toolCall("reply", {}, "reply-empty-args"),
						toolCall("reply", { content: "   " }, "reply-blank"),
						toolCall(
							"reply",
							{ content: "not actually sent", messageRef: "missing" },
							"reply-bad-ref",
						),
						toolCall("reply", { content: "actual reply" }, "reply-ok"),
					],
				}),
			)
			.mockResolvedValueOnce(chatResponse());

		const def = makeAgent(tmpDir, { tools: ["reply"] });
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 2, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result.replyContent).toBe("actual reply");
	});

	it("recovers direct assistant content as a visible fallback reply", async () => {
		sendMock.mockResolvedValueOnce(
			chatResponse({ content: "  I should have used reply.  " }),
		);

		const def = makeAgent(tmpDir, { tools: ["reply"] });
		const turn = makeTurn({
			agent: def,
			runId: "run-direct-reply",
			config: { report: true, stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result.replyContent).toBe("I should have used reply.");
		expect(result.steps[0]).toMatchObject({
			fallback: "assistant_content_reply",
			toolCalls: [
				{
					toolCallId: "fallback-reply-1",
					toolName: "reply",
					args: { content: "I should have used reply." },
				},
			],
			toolResults: [
				{ toolCallId: "fallback-reply-1", toolName: "reply", result: "sent" },
			],
		});

		const report = await waitForReport("run-direct-reply");
		expect(report.llm?.steps[0]).toMatchObject({
			fallback: "assistant_content_reply",
			toolCalls: [
				{ tool: "reply", args: { content: "I should have used reply." } },
			],
			toolResults: [{ tool: "reply", result: "sent" }],
		});
	});

	it("does not recover direct assistant content when tools are disabled", async () => {
		sendMock.mockResolvedValueOnce(chatResponse({ content: "plain text" }));

		const def = makeAgent(tmpDir, { tools: ["reply"] });
		const turn = makeTurn({
			agent: def,
			config: {
				report: false,
				stepLimit: 1,
				skipHistory: true,
				toolChoice: "none",
			},
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result.replyContent).toBe("");
		expect(result.steps[0]).toMatchObject({
			toolCalls: [],
			toolResults: [],
		});
		expect(result.steps[0]?.fallback).toBeUndefined();
	});

	it("renders # Message with schedule metadata for frontmatter schedule runs", async () => {
		sendMock.mockResolvedValueOnce(chatResponse({ content: "ok" }));

		const def = makeAgent(tmpDir, {
			prompt: {
				system: "You are core-test.",
				message:
					'{{#if (eq schedule.label "morning")}}Morning {{schedule.pattern}}{{else}}Other{{/if}}',
			},
		});
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 1, skipHistory: true },
			trigger: { kind: "schedule", scheduleId: "frontmatter:core-test:0" },
			schedule: {
				id: "frontmatter:core-test:0",
				pattern: "0 8 * * *",
				label: "morning",
			},
		});

		const result = await executeAgent({
			turn,
			def,
			variables: [
				{
					key: "schedule",
					run: async (t) => t.schedule ?? null,
				},
			],
		});

		expect(result.userMessage).toBe("Morning 0 8 * * *");
		expect(firstChatRequest().messages).toContainEqual({
			role: "user",
			content: "Morning 0 8 * * *",
		});
	});

	it("renders # Message with dispatch metadata for dispatch and timer runs", async () => {
		sendMock.mockResolvedValueOnce(chatResponse({ content: "ok" }));

		const def = makeAgent(tmpDir, {
			prompt: {
				system: "You are core-test.",
				message: "Objective: {{dispatch.prompt}} / {{test}}",
			},
		});
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 1, skipHistory: true },
			trigger: { kind: "dispatch", parentRunId: "parent-1" },
			dispatchContext: { prompt: "run the check" },
		});

		const result = await executeAgent({
			turn,
			def,
			variables: [
				{
					key: "dispatch",
					run: async (t) => t.dispatchContext ?? null,
				},
				{
					key: "test",
					run: async () => "value",
				},
			],
		});

		expect(result.userMessage).toBe("Objective: run the check / value");
		expect(firstChatRequest().messages).toContainEqual({
			role: "user",
			content: "Objective: run the check / value",
		});
	});

	it("uses the raw dispatch objective when an agent has no # Message section", async () => {
		sendMock.mockResolvedValueOnce(chatResponse({ content: "ok" }));

		const def = makeAgent(tmpDir);
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 1, skipHistory: true },
			trigger: { kind: "timer", timerId: "timer-1" },
			dispatchContext: { prompt: "raw objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result.userMessage).toBe("raw objective");
		expect(firstChatRequest().messages).toContainEqual({
			role: "user",
			content: "raw objective",
		});
	});

	it("throws LlmTimeoutError without retrying when the model call times out", async () => {
		settings.agent.timeout = 5;
		settings.agent.retries.max = 3;
		sendMock.mockImplementation(
			(_body: unknown, options?: { signal?: AbortSignal }) =>
				rejectWhenAborted(options?.signal),
		);

		const def = makeAgent(tmpDir);
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		await expect(executeAgent({ turn, def, variables: [] })).rejects.toThrow(
			LlmTimeoutError,
		);
		expect(sendMock).toHaveBeenCalledTimes(1);
	});

	it("retries transient failures and then continues with the successful response", async () => {
		settings.agent.retries.max = 3;
		settings.agent.retries.backoffMs = 0;
		sendMock
			.mockRejectedValueOnce(new Error("socket closed"))
			.mockResolvedValueOnce(chatResponse({ content: "ok" }));

		const def = makeAgent(tmpDir);
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result.steps).toHaveLength(1);
		expect(sendMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry rate-limit style errors", async () => {
		settings.agent.retries.max = 3;
		sendMock.mockRejectedValueOnce(new Error("rate limit exceeded"));

		const def = makeAgent(tmpDir);
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		await expect(executeAgent({ turn, def, variables: [] })).rejects.toThrow(
			/rate limit/i,
		);
		expect(sendMock).toHaveBeenCalledTimes(1);
	});

	it("emits a report on success", async () => {
		sendMock.mockResolvedValueOnce(
			chatResponse({
				toolCalls: [toolCall("probe", { value: "reported" }, "probe-1")],
			}),
		);

		const def = makeAgent(tmpDir, { tools: ["probe"] });
		const turn = makeTurn({
			agent: def,
			runId: "run-report-ok",
			config: { report: true, stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		await executeAgent({ turn, def, variables: [] });

		const report = await waitForReport("run-report-ok");
		expect(report).toMatchObject({
			runId: "run-report-ok",
			agent: "core-test",
			outcome: { kind: "ok" },
			llm: {
				model: "anthropic/claude-sonnet-4.6",
				steps: [
					{
						toolCalls: [{ tool: "probe", args: { value: "reported" } }],
						toolResults: [
							{ tool: "probe", result: { ok: true, value: "reported" } },
						],
					},
				],
			},
		});
	});

	it("emits an error report when the model loop fails", async () => {
		sendMock.mockRejectedValueOnce(new Error("rate limit exceeded"));

		const def = makeAgent(tmpDir);
		const turn = makeTurn({
			agent: def,
			runId: "run-report-error",
			config: { report: true, stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		await expect(executeAgent({ turn, def, variables: [] })).rejects.toThrow(
			/rate limit/i,
		);

		const report = await waitForReport("run-report-error");
		expect(report).toMatchObject({
			runId: "run-report-error",
			outcome: {
				kind: "error",
				error: { name: "Error", message: "rate limit exceeded" },
			},
		});
	});

	it("persists non-reply tool traces with the runId and trigger", async () => {
		sendMock
			.mockResolvedValueOnce(
				chatResponse({
					toolCalls: [
						toolCall("reply", { content: "not traced" }, "reply-1"),
						toolCall("probe", { value: "traced" }, "probe-1"),
					],
				}),
			)
			.mockResolvedValueOnce(chatResponse());

		const def = makeAgent(tmpDir, { tools: ["reply", "probe"] });
		const turn = makeTurn({
			agent: def,
			runId: "run-trace",
			trigger: { kind: "message", messageId: "message-1" },
			config: { report: false, stepLimit: 2, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		await executeAgent({ turn, def, variables: [] });

		const trace = await waitForTrace("run-trace");
		expect(trace).toMatchObject({
			agent: "core-test",
			trigger: { kind: "message", messageId: "message-1" },
			steps: [
				{
					toolCalls: [
						{
							toolCallId: "probe-1",
							toolName: "probe",
							args: JSON.stringify({ value: "traced" }),
						},
					],
					toolResults: [
						{
							toolCallId: "probe-1",
							toolName: "probe",
							result: JSON.stringify({ ok: true, value: "traced" }),
						},
					],
				},
			],
		});
	});

	it("does not persist traces for ghost turns", async () => {
		sendMock
			.mockResolvedValueOnce(
				chatResponse({
					toolCalls: [toolCall("probe", { value: "private" }, "probe-1")],
				}),
			)
			.mockResolvedValueOnce(chatResponse());

		const def = makeAgent(tmpDir, { tools: ["probe"] });
		const turn = makeTurn({
			agent: def,
			runId: "run-ghost",
			config: { ghost: true, report: false, stepLimit: 2, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		await executeAgent({ turn, def, variables: [] });
		await pause();

		expect((await getTraces()).has("run-ghost")).toBe(false);
	});

	it("forces a dynamic-persistence tool call and schedules the returned timer", async () => {
		const started = Date.now();
		sendMock
			.mockResolvedValueOnce(
				chatResponse({
					toolCalls: [toolCall("reply", { content: "done" }, "reply-1")],
				}),
			)
			.mockResolvedValueOnce(chatResponse())
			.mockResolvedValueOnce(
				chatResponse({
					toolCalls: [
						toolCall("persist", {
							nextRun: "30m",
							prompt: "check in again",
							overrides: ["voice"],
						}),
					],
				}),
			);

		const def = makeAgent(tmpDir, {
			tools: ["reply"],
			persistence: { hint: "Pick a useful follow-up.", overrides: [] },
		});
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 2, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		await executeAgent({ turn, def, variables: [] });

		const timers = listTimers();
		expect(timers).toHaveLength(1);
		expect(timers[0]).toMatchObject({
			agentName: "core-test",
			objective: "check in again",
			overrides: ["voice"],
			createdBy: "persistent",
		});
		expect(new Date(timers[0]?.runAt ?? 0).getTime()).toBeGreaterThanOrEqual(
			started + 30 * 60 * 1_000 - 500,
		);
		expect(new Date(timers[0]?.runAt ?? 0).getTime()).toBeLessThanOrEqual(
			Date.now() + 30 * 60 * 1_000 + 500,
		);
		expect(thirdChatRequest()).toMatchObject({
			toolChoice: { type: "function", function: { name: "persist" } },
		});
	});

	it("throws and avoids scheduling when dynamic persistence omits the persist tool", async () => {
		sendMock
			.mockResolvedValueOnce(chatResponse({ content: "main run" }))
			.mockResolvedValueOnce(chatResponse({ content: "no tool" }));

		const def = makeAgent(tmpDir, {
			persistence: { hint: "Pick a useful follow-up.", overrides: [] },
		});
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		await expect(executeAgent({ turn, def, variables: [] })).rejects.toThrow(
			"@core-test: persist tool was not called",
		);
		expect(listTimers()).toEqual([]);
	});
});

function makeAgent(
	dir: string,
	patch: {
		tools?: string[];
		toolsets?: string[];
		persistence?: AgentDefinition["persistence"];
		prompt?: AgentDefinition["prompt"];
	} = {},
): AgentDefinition {
	const promptPath = path.join(dir, `${crypto.randomUUID()}.md`);
	writeFileSync(promptPath, "---\nname: core-test\n---\nYou are core-test.");
	const parsed = AgentSchema.parse({
		name: "core-test",
		tools: patch.tools ?? [],
		toolsets: patch.toolsets ?? [],
		report: false,
		stepLimit: 2,
		...(patch.persistence
			? {
					persist: true,
					persistHint: patch.persistence.hint,
					persistOverrides: patch.persistence.overrides,
				}
			: {}),
	});
	return {
		...parsed,
		promptPath,
		prompt: patch.prompt ?? { system: "You are core-test." },
	};
}

function chatResponse(
	input: {
		content?: string;
		toolCalls?: ReturnType<typeof toolCall>[];
		reasoning?: string;
		usage?: { promptTokens: number; completionTokens: number };
		finishReason?: string;
	} = {},
) {
	return {
		choices: [
			{
				index: 0,
				finishReason:
					input.finishReason ??
					(input.toolCalls?.length ? "tool_calls" : "stop"),
				message: {
					role: "assistant",
					content: input.content ?? "",
					reasoning: input.reasoning ?? null,
					toolCalls: input.toolCalls ?? [],
				},
			},
		],
		usage: input.usage ?? { promptTokens: 1, completionTokens: 1 },
	};
}

function toolCall(
	name: string,
	args: Record<string, unknown>,
	id: string = crypto.randomUUID(),
) {
	return {
		id,
		type: "function",
		function: {
			name,
			arguments: JSON.stringify(args),
		},
	};
}

function firstChatRequest(): Record<string, unknown> {
	return chatRequestAt(0);
}

function secondChatRequest(): Record<string, unknown> {
	return chatRequestAt(1);
}

function thirdChatRequest(): Record<string, unknown> {
	return chatRequestAt(2);
}

function chatRequestAt(index: number): Record<string, unknown> {
	const call = sendMock.mock.calls[index]?.[0] as
		| { chatRequest?: Record<string, unknown> }
		| undefined;
	const request = call?.chatRequest;
	if (!request) throw new Error(`Missing chat request at index ${index}`);
	return request;
}

function rejectWhenAborted(signal?: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		const abort = () => reject(new DOMException("Aborted", "AbortError"));
		if (signal?.aborted) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

async function waitForReport(runId: string) {
	return waitFor(async () => {
		const reports = await readReports({ runId, days: 1 });
		return reports[0];
	}, `report ${runId}`);
}

async function waitForTrace(runId: string) {
	return waitFor(async () => (await getTraces()).get(runId), `trace ${runId}`);
}

async function waitFor<T>(
	fn: () => Promise<T | undefined>,
	label: string,
): Promise<T> {
	for (let i = 0; i < 50; i++) {
		const value = await fn();
		if (value !== undefined) return value;
		await pause();
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function pause(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
