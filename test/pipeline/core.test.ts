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
const sendMessageSchema = z.object({
	text: z.string({ error: "Send the complete message text in text." }),
});
const probeSchema = z.object({ value: z.string().optional() });
const hiddenSchema = z.object({});

function defaultModel(tier: "medium" | "large"): string {
	const provider = settings.providers[settings.defaultProvider];
	if (!provider) throw new Error(`Missing provider ${settings.defaultProvider}`);
	return provider[tier];
}

vi.mock("@openrouter/sdk", () => ({
	OpenRouter: vi.fn(function OpenRouter() {
		return {
			chat: {
				send: sendMock,
			},
		};
	}),
}));

const sendMessageTool: ToolDefinition<typeof sendMessageSchema> = {
	name: "send_message",
	description: "Send message with text",
	inputSchema: sendMessageSchema,
	execute: async ({ text }) =>
		text === "not actually sent" ? { error: "not sent" } : "sent",
};

const probeTool: ToolDefinition<typeof probeSchema> = {
	name: "probe",
	description: "Record a probe value",
	inputSchema: probeSchema,
	execute: async ({ value }) => ({ ok: true, value: value ?? "default" }),
};

const hiddenTool: ToolDefinition<typeof hiddenSchema> = {
	name: "bundle_hidden",
	description: "Hidden toolset member",
	inputSchema: hiddenSchema,
	execute: async () => ({ ok: true }),
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
		settings.persistence.minNextRun = "1s";
		settings.persistence.maxNextRun = "1h";
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

		registerTool(sendMessageTool);
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
						toolCall("send_message", { text: "hello" }, "send_message-1"),
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

		const def = makeAgent(tmpDir, { tools: ["send_message", "probe"] });
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 2, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result).toMatchObject({
			model: defaultModel("medium"),
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
					toolCallId: "send_message-1",
					toolName: "send_message",
					args: { text: "hello" },
				},
				{ toolCallId: "probe-1", toolName: "probe", args: { value: "seen" } },
			],
			toolResults: [
				{
					toolCallId: "send_message-1",
					toolName: "send_message",
					result: "sent",
				},
				{
					toolCallId: "probe-1",
					toolName: "probe",
					result: { ok: true, value: "seen" },
				},
			],
		});
		expect(firstChatRequest()).toMatchObject({
			model: defaultModel("medium"),
			messages: [
				{ role: "system", content: "You are core-test." },
				{ role: "user", content: "objective" },
			],
		});
		expect(firstChatRequest().tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					function: expect.objectContaining({ name: "send_message" }),
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

	it("joins send_message tool calls and ignores non-send_message calls when deriving replyContent", async () => {
		sendMock
			.mockResolvedValueOnce(
				chatResponse({
					toolCalls: [
						toolCall("send_message", { text: "first" }, "send_message-1"),
						toolCall("probe", { value: "ignored" }, "probe-1"),
						toolCall("send_message", { text: "second" }, "send_message-2"),
					],
				}),
			)
			.mockResolvedValueOnce(chatResponse());

		const def = makeAgent(tmpDir, { tools: ["send_message", "probe"] });
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
			tools: ["send_message"],
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
			tools: ["send_message"],
			serverTools: [],
			toolsets: ["bundle"],
			skills: [],
		});
	});

	it("reports server tools separately and captures surfaced server metadata", async () => {
		sendMock.mockResolvedValueOnce(
			chatResponse({
				content: "done",
				usage: {
					promptTokens: 3,
					completionTokens: 4,
					serverToolUse: { web_search_requests: 1 },
				},
				annotations: [
					{
						type: "url_citation",
						url_citation: {
							url: "https://example.com/result",
							title: "Result",
							content: "search excerpt",
							start_index: 5,
							end_index: 12,
						},
					},
				],
			}),
		);

		const def = makeAgent(tmpDir, {
			tools: ["send_message"],
			serverTools: ["web_search"],
		});
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(firstChatRequest().tools).toEqual(
			expect.arrayContaining([{ type: "openrouter:web_search" }]),
		);
		expect(result.context).toEqual({
			variables: [],
			tools: ["send_message"],
			serverTools: ["openrouter:web_search"],
			toolsets: [],
			skills: [],
		});
		expect(result.steps[0]).toMatchObject({
			serverToolUse: { web_search_requests: 1 },
			citations: [
				{
					type: "url_citation",
					url: "https://example.com/result",
					title: "Result",
					content: "search excerpt",
					startIndex: 5,
					endIndex: 12,
				},
			],
		});
	});

	it("derives replyContent from accepted send_message tool calls only", async () => {
		sendMock
			.mockResolvedValueOnce(
				chatResponse({
					toolCalls: [
						toolCall("send_message", {}, "send_message-empty-args"),
						toolCall("send_message", { text: "   " }, "send_message-blank"),
						toolCall(
							"send_message",
							{ text: "not actually sent", quoteMessageLabel: 99 },
							"send_message-bad-ref",
						),
						toolCall(
							"send_message",
							{ text: "actual send_message" },
							"send_message-ok",
						),
					],
				}),
			)
			.mockResolvedValueOnce(chatResponse());

		const def = makeAgent(tmpDir, { tools: ["send_message"] });
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 2, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result.replyContent).toBe("actual send_message");
	});

	it("can recover direct assistant text after an invalid send_message call", async () => {
		sendMock
			.mockResolvedValueOnce(
				chatResponse({
					toolCalls: [toolCall("send_message", {}, "send_message-empty-args")],
				}),
			)
			.mockResolvedValueOnce(
				chatResponse({ content: "Recovered final answer." }),
			);

		const def = makeAgent(tmpDir, { tools: ["send_message"] });
		const turn = makeTurn({
			agent: def,
			config: { report: false, stepLimit: 2, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result.replyContent).toBe("Recovered final answer.");
		expect(result.steps[0]?.toolResults[0]?.result).toMatchObject({
			error: expect.stringContaining("Send the complete message text in text."),
		});
		expect(result.steps[1]).toMatchObject({
			fallback: "assistant_content_reply",
			toolCalls: [
				{
					toolName: "send_message",
					args: { text: "Recovered final answer." },
				},
			],
		});
	});

	it("recovers direct assistant text as a visible fallback send_message", async () => {
		sendMock.mockResolvedValueOnce(
			chatResponse({ content: "  I should have used send_message.  " }),
		);

		const def = makeAgent(tmpDir, { tools: ["send_message"] });
		const turn = makeTurn({
			agent: def,
			runId: "run-direct-send_message",
			config: { report: true, stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result.replyContent).toBe("I should have used send_message.");
		expect(result.steps[0]).toMatchObject({
			fallback: "assistant_content_reply",
			toolCalls: [
				{
					toolCallId: "fallback-send-message-1",
					toolName: "send_message",
					args: { text: "I should have used send_message." },
				},
			],
			toolResults: [
				{
					toolCallId: "fallback-send-message-1",
					toolName: "send_message",
					result: "sent",
				},
			],
		});

		const report = await waitForReport("run-direct-send_message");
		expect(report.llm?.steps[0]).toMatchObject({
			fallback: "assistant_content_reply",
			toolCalls: [
				{
					tool: "send_message",
					args: { text: "I should have used send_message." },
				},
			],
			toolResults: [{ tool: "send_message", result: "sent" }],
		});
	});

	it("does not recover direct assistant text when tools are disabled", async () => {
		sendMock.mockResolvedValueOnce(chatResponse({ content: "plain text" }));

		const def = makeAgent(tmpDir, { tools: ["send_message"] });
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
				model: defaultModel("medium"),
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

	it("persists non-send_message tool traces with the runId and trigger", async () => {
		sendMock
			.mockResolvedValueOnce(
				chatResponse({
					toolCalls: [
						toolCall("send_message", { text: "not traced" }, "send_message-1"),
						toolCall("probe", { value: "traced" }, "probe-1"),
					],
				}),
			)
			.mockResolvedValueOnce(chatResponse());

		const def = makeAgent(tmpDir, { tools: ["send_message", "probe"] });
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
					toolCalls: [
						toolCall("send_message", { text: "done" }, "send_message-1"),
					],
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
			tools: ["send_message"],
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
		serverTools?: string[];
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
		serverTools: patch.serverTools ?? [],
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
		usage?: {
			promptTokens: number;
			completionTokens: number;
			serverToolUse?: Record<string, number>;
		};
		finishReason?: string;
		annotations?: unknown[];
	} = {},
) {
	const usage = input.usage ?? { promptTokens: 1, completionTokens: 1 };
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
					...(input.annotations ? { annotations: input.annotations } : {}),
				},
			},
		],
		usage: {
			promptTokens: usage.promptTokens,
			completionTokens: usage.completionTokens,
			...(usage.serverToolUse ? { serverToolUse: usage.serverToolUse } : {}),
		},
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
