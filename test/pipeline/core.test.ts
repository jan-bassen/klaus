import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { settings } from "../../src/infra/config.ts";
import { getTraces } from "../../src/infra/store/history.ts";
import { readReports } from "../../src/infra/store/report.ts";
import { listTimers, stopAllTimers } from "../../src/infra/store/timers.ts";
import { enqueueMessage } from "../../src/infra/whatsapp/send.ts";
import {
	type AgentDefinition,
	AgentSchema,
} from "../../src/pipeline/agents.ts";
import { executeAgent, LlmTimeoutError } from "../../src/pipeline/core.ts";
import {
	registerTool,
	type ToolDefinition,
} from "../../src/primitives/tools/index.ts";
import { initAllStores } from "../helpers/stores.ts";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.ts";
import { makeTurn } from "../helpers/turn.ts";

const sendMock = vi.hoisted(() => vi.fn());
const replySchema = z.object({ content: z.string() });
const probeSchema = z.object({ value: z.string().optional() });

vi.mock("@openrouter/sdk", () => ({
	OpenRouter: vi.fn(function OpenRouter() {
		return {
			chat: {
				send: sendMock,
			},
		};
	}),
}));

vi.mock("../../src/infra/whatsapp/send.ts", () => ({
	enqueueMessage: vi.fn(),
}));

const replyTool: ToolDefinition<typeof replySchema> = {
	name: "reply",
	description: "Reply with text",
	inputSchema: replySchema,
	execute: async () => "sent",
	sideEffect: "pure",
	kind: "builtin",
	capability: "tool",
};

const probeTool: ToolDefinition<typeof probeSchema> = {
	name: "probe",
	description: "Record a probe value",
	inputSchema: probeSchema,
	execute: async ({ value }) => ({ ok: true, value: value ?? "default" }),
	sideEffect: "pure",
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

		registerTool(replyTool);
		registerTool(probeTool);
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
		vi.mocked(enqueueMessage).mockReset();
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
			config: { report: "none", stepLimit: 2, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result).toMatchObject({
			model: "anthropic/claude-sonnet-4-6",
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
			model: "anthropic/claude-sonnet-4-6",
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
			config: { report: "none", stepLimit: 2, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		const result = await executeAgent({ turn, def, variables: [] });

		expect(result.replyContent).toBe("first\n---\nsecond");
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
			config: { report: "none", stepLimit: 1, skipHistory: true },
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
			config: { report: "none", stepLimit: 1, skipHistory: true },
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
			config: { report: "none", stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		await expect(executeAgent({ turn, def, variables: [] })).rejects.toThrow(
			/rate limit/i,
		);
		expect(sendMock).toHaveBeenCalledTimes(1);
	});

	it("emits a short report on success", async () => {
		sendMock.mockResolvedValueOnce(
			chatResponse({
				toolCalls: [toolCall("probe", { value: "reported" }, "probe-1")],
			}),
		);

		const def = makeAgent(tmpDir, { tools: ["probe"] });
		const turn = makeTurn({
			agent: def,
			runId: "run-report-ok",
			config: { report: "short", stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		await executeAgent({ turn, def, variables: [] });

		const report = await waitForReport("run-report-ok");
		expect(report).toMatchObject({
			runId: "run-report-ok",
			agent: "core-test",
			level: "short",
			outcome: { kind: "ok" },
			llm: {
				model: "anthropic/claude-sonnet-4-6",
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
			config: { report: "short", stepLimit: 1, skipHistory: true },
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
			config: { report: "none", stepLimit: 2, skipHistory: true },
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
			config: { ghost: true, report: "none", stepLimit: 2, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		await executeAgent({ turn, def, variables: [] });
		await pause();

		expect((await getTraces()).has("run-ghost")).toBe(false);
	});

	it("flushes pending sub-replies to WhatsApp in slot order and clears them", async () => {
		sendMock.mockResolvedValueOnce(chatResponse());
		const def = makeAgent(tmpDir);
		const turn = makeTurn({
			agent: def,
			runId: "run-sub",
			config: { report: "none", stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
			pendingSubReplies: [["first"], ["second", "third"]],
		});

		await executeAgent({ turn, def, variables: [] });

		expect(vi.mocked(enqueueMessage).mock.calls.map((call) => call[0])).toEqual(
			[
				expect.objectContaining({
					chatId: "c1",
					content: "first",
					label: "core-test",
				}),
				expect.objectContaining({
					chatId: "c1",
					content: "second",
					label: "core-test",
				}),
				expect.objectContaining({
					chatId: "c1",
					content: "third",
					label: "core-test",
				}),
			],
		);
		expect(turn.pendingSubReplies).toEqual([]);
	});

	it("bubbles pending sub-replies into a parent collector instead of WhatsApp", async () => {
		sendMock.mockResolvedValueOnce(chatResponse());
		const collector: string[] = [];
		const def = makeAgent(tmpDir);
		const turn = makeTurn({
			agent: def,
			config: { report: "none", stepLimit: 1, skipHistory: true },
			dispatchContext: { prompt: "objective" },
			pendingSubReplies: [["alpha"], ["beta"]],
			_replyCollector: collector,
		});

		await executeAgent({ turn, def, variables: [] });

		expect(collector).toEqual(["alpha", "beta"]);
		expect(enqueueMessage).not.toHaveBeenCalled();
		expect(turn.pendingSubReplies).toEqual([]);
	});

	it("drops top-level pending sub-replies during simulation", async () => {
		sendMock.mockResolvedValueOnce(chatResponse());
		const def = makeAgent(tmpDir);
		const turn = makeTurn({
			agent: def,
			config: {
				simulate: true,
				report: "none",
				stepLimit: 1,
				skipHistory: true,
			},
			dispatchContext: { prompt: "objective" },
			pendingSubReplies: [["dry run"]],
		});

		await executeAgent({ turn, def, variables: [] });

		expect(enqueueMessage).not.toHaveBeenCalled();
		expect(turn.pendingSubReplies).toEqual([]);
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
			persistence: { mode: "dynamic", hint: "Pick a useful follow-up." },
		});
		const turn = makeTurn({
			agent: def,
			config: { report: "none", stepLimit: 2, skipHistory: true },
			dispatchContext: { prompt: "objective" },
		});

		await executeAgent({ turn, def, variables: [] });

		const timers = listTimers();
		expect(timers).toHaveLength(1);
		expect(timers[0]).toMatchObject({
			agentName: "core-test",
			chatId: "c1",
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
			persistence: { mode: "dynamic", hint: "Pick a useful follow-up." },
		});
		const turn = makeTurn({
			agent: def,
			config: { report: "none", stepLimit: 1, skipHistory: true },
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
		persistence?: AgentDefinition["persistence"];
	} = {},
): AgentDefinition {
	const promptPath = path.join(dir, `${crypto.randomUUID()}.md`);
	writeFileSync(promptPath, "---\nname: core-test\n---\nYou are core-test.");
	const parsed = AgentSchema.parse({
		name: "core-test",
		tools: patch.tools ?? [],
		report: "none",
		stepLimit: 2,
		...(patch.persistence?.mode === "dynamic"
			? {
					persistenceMode: "dynamic",
					persistenceHint: patch.persistence.hint,
				}
			: {}),
	});
	return { ...parsed, promptPath };
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
