/**
 * End-to-end happy path through `handleTurn`.
 *
 * Setup strategy:
 *   - Mock `src/infra/whatsapp/send.ts` so `enqueueMessage` becomes a spy.
 *   - Mock `@openrouter/sdk` so `new OpenRouter(...).chat.send` returns
 *     canned `ChatResult` payloads with a single `send_message` tool call.
 *   - `initAllStores(tmpDir)` in beforeEach; point `settings.basics.allowedChat`
 *     at a known chatId (mutate the live `settings` object from `src/infra/config.ts`
 *     directly in beforeEach, or use `vi.resetModules` + dynamic import).
 *   - Register the `send_message` tool and a minimal agent manually (bypass glob load).
 *
 * Universal gotcha: `src/infra/logger.ts` eagerly reads settings — `test/setup.ts`
 * preloads `src/infra/config.ts` to avoid the crash. Don't reorder.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { settings } from "../../src/infra/config.ts";
import { persistFileBlob } from "../../src/infra/store/files.ts";
import {
	appendMessage,
	getConversation,
	getTraces,
} from "../../src/infra/store/history.ts";
import { readReports } from "../../src/infra/store/report.ts";
import {
	startPresence,
	stopPresence,
} from "../../src/infra/whatsapp/presence.ts";
import type { InboundMessage } from "../../src/infra/whatsapp/receive.ts";
import { enqueueMessage, sendReaction } from "../../src/infra/whatsapp/send.ts";
import type { AgentDefinition } from "../../src/pipeline/agents.ts";
import {
	AgentSchema,
	agentRegistry,
	setDefaultAgent,
} from "../../src/pipeline/agents.ts";
import { handleTurn } from "../../src/pipeline/index.ts";
import {
	clearNextPrefix,
	getNextPrefix,
	setNextPrefix,
} from "../../src/pipeline/next.ts";
import { overrideRegistry } from "../../src/pipeline/overrides.ts";
import { registry as commandRegistry } from "../../src/primitives/commands/index.ts";
import {
	registerTool,
	type ToolDefinition,
} from "../../src/primitives/tools/index.ts";
import { sendMessageTool } from "../../src/primitives/tools/message.ts";
import { initAllStores } from "../helpers/stores.ts";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.ts";

const sendMock = vi.hoisted(() => vi.fn());
const probeSchema = z.object({ value: z.number() });

function defaultModel(tier: "medium" | "large"): string {
	const provider = settings.providers[settings.defaultProvider];
	if (!provider) throw new Error(`Missing provider ${settings.defaultProvider}`);
	return provider[tier];
}

const probeTool: ToolDefinition<typeof probeSchema> = {
	name: "probe",
	description: "Probe tool for index tests",
	inputSchema: probeSchema,
	execute: async ({ value }) => ({ value }),
};

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
	sendReaction: vi.fn(),
}));

vi.mock("../../src/infra/whatsapp/presence.ts", () => ({
	startPresence: vi.fn(),
	setPresenceKind: vi.fn(),
	stopPresence: vi.fn(),
}));

describe("pipeline/index.handleTurn", () => {
	let tmpDir: string;
	let originalAllowedChat: string | undefined;
	let originalTemplatesDir: string;
	let originalApiKey: string | undefined;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);

		originalAllowedChat = settings.basics.allowedChat;
		originalTemplatesDir = settings.vault.templatesDir;
		originalApiKey = process.env.OPENROUTER_API_KEY;

		settings.basics.allowedChat = "chat1";
		settings.vault.templatesDir = path.join(tmpDir, "templates");
		process.env.OPENROUTER_API_KEY = "test-key";

		mkdirSync(settings.vault.templatesDir, { recursive: true });
		writeFileSync(
			path.join(settings.vault.templatesDir, "message-user.md"),
			"{{messageText}}",
		);
		writeFileSync(
			path.join(settings.vault.templatesDir, "message-agent.md"),
			"{{#if isNotDefaultAgent}}[{{agentLabel}}] {{/if}}{{message}}",
		);
		writeFileSync(
			path.join(settings.vault.templatesDir, "history-user.md"),
			"{{messageText}}",
		);
		writeFileSync(
			path.join(settings.vault.templatesDir, "history-agent.md"),
			"{{#if isNotDefaultAgent}}[{{agentLabel}}] {{/if}}{{message}}",
		);
		writeFileSync(
			path.join(settings.vault.templatesDir, "welcome.md"),
			"Hey! Klaus is set up and ready to go 🤙",
		);

		registerTool(sendMessageTool);
		registerTool(probeTool);
		agentRegistry.set("default", makeAgent("default", tmpDir));
		agentRegistry.set("researcher", makeAgent("researcher", tmpDir));
		agentRegistry.set("reporter", makeAgent("reporter", tmpDir, true));
		setDefaultAgent("chat1", "default");
		clearNextPrefix("chat1");
		overrideRegistry.set("large", {
			name: "large",
			description: "Use the large model",
			overrides: { modelTier: "large" },
		});
	});

	afterEach(() => {
		setDefaultAgent("chat1", null);
		clearNextPrefix("chat1");
		settings.vault.templatesDir = originalTemplatesDir;
		if (originalAllowedChat === undefined) {
			delete settings.basics.allowedChat;
		} else {
			settings.basics.allowedChat = originalAllowedChat;
		}
		if (originalApiKey === undefined) {
			delete process.env.OPENROUTER_API_KEY;
		} else {
			process.env.OPENROUTER_API_KEY = originalApiKey;
		}
		sendMock.mockReset();
		vi.mocked(enqueueMessage).mockReset();
		vi.mocked(sendReaction).mockReset();
		vi.mocked(startPresence).mockReset();
		vi.mocked(stopPresence).mockReset();
		rmTmpDir(tmpDir);
	});

	it("routes a text message to the default agent and enqueues the assistant send_message", async () => {
		sendMock.mockResolvedValueOnce(replyResponse("hello back"));

		await handleTurn(makeMsg("chat1", "", "hello"));

		expect(sendMock).toHaveBeenCalledOnce();
		expect(enqueueMessage).toHaveBeenCalledOnce();
		expect(vi.mocked(enqueueMessage).mock.calls[0]?.[0]).toMatchObject({
			chatId: "chat1",
			content: "hello back",
			label: "default",
		});
	});

	it("clears active presence after a user-visible send_message is queued", async () => {
		sendMock.mockResolvedValueOnce(replyResponse("hello back"));

		await handleTurn(makeMsg("chat1", "", "hello"));

		expect(startPresence).toHaveBeenCalledWith("chat1", "composing");
		expect(stopPresence).toHaveBeenCalledWith("chat1");
		expect(stopPresence).toHaveBeenCalledTimes(2);
		const enqueueOrder = vi.mocked(enqueueMessage).mock.invocationCallOrder[0];
		const firstStopOrder = vi.mocked(stopPresence).mock.invocationCallOrder[0];
		if (enqueueOrder === undefined || firstStopOrder === undefined) {
			throw new Error("missing mock call order");
		}
		expect(enqueueOrder).toBeLessThan(firstStopOrder);
	});

	it("persists user, assistant, and trace rows for a normal turn", async () => {
		sendMock
			.mockResolvedValueOnce(mixedResponse("remembered", "probe", { value: 2 }))
			.mockResolvedValueOnce(stopResponse());
		const msg = makeMsg("chat1", "", "remember this");

		await handleTurn(msg);

		const rows = await getConversation();
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "user",
					content: "remember this",
					externalId: msg.id,
				}),
				expect.objectContaining({
					role: "assistant",
					content: "remembered",
					agent: "default",
					runId: expect.any(String),
				}),
			]),
		);
		const assistant = rows.find((row) => row.role === "assistant");
		expect(assistant?.runId).toEqual(expect.any(String));

		const trace = await waitForTrace(assistant?.runId ?? "");
		expect(trace).toMatchObject({
			agent: "default",
			trigger: { kind: "message", messageId: msg.id },
			steps: [
				expect.objectContaining({
					toolCalls: [expect.objectContaining({ toolName: "probe" })],
				}),
			],
		});
	});

	it("persists quoted context from the stored original message", async () => {
		const quotedExternalId = "quoted-stored";
		await appendMessage({
			role: "assistant",
			agent: "default",
			runId: "quoted-run",
			content: "the earlier answer",
			externalId: quotedExternalId,
		});
		sendMock.mockResolvedValueOnce(replyResponse("reply"));
		const msg: InboundMessage = {
			...makeMsg("chat1", "", "following up"),
			quotedMessage: { externalId: quotedExternalId },
		};

		await handleTurn(msg);

		const row = (await getConversation()).find(
			(entry) => entry.externalId === msg.id,
		);
		expect(row).toMatchObject({
			quotedText: "the earlier answer",
			quotedRole: "assistant",
		});
	});

	it("persists a quoted media descriptor when no quoted text exists", async () => {
		const saved = await persistFileBlob({
			bytes: Buffer.from("source image"),
			mimeType: "image/png",
			externalId: "quoted-image",
		});
		if (saved instanceof Error) throw saved;
		sendMock.mockResolvedValueOnce(replyResponse("reply"));
		const msg: InboundMessage = {
			...makeMsg("chat1", "", "what is this?"),
			quotedMessage: { externalId: "quoted-image" },
		};

		await handleTurn(msg);

		const row = (await getConversation()).find(
			(entry) => entry.externalId === msg.id,
		);
		expect(row).toMatchObject({
			quotedText: "quoted image",
			quotedRole: "user",
		});
	});

	it("writes a report when the routed agent requests reports", async () => {
		sendMock.mockResolvedValueOnce(replyResponse("reported"));
		const msg = makeMsg("chat1", "reporter", "please report");

		await handleTurn(msg);

		const report = await waitForReport("reporter");
		expect(report).toMatchObject({
			agent: "reporter",
			chatId: "chat1",
			trigger: { kind: "message", messageId: msg.id },
			outcome: { kind: "ok" },
			llm: expect.objectContaining({
				model: defaultModel("medium"),
				steps: [
					expect.objectContaining({
						toolCalls: [expect.objectContaining({ tool: "send_message" })],
					}),
				],
			}),
		});
	});

	it("rejects messages from non-allowlisted chatIds", async () => {
		await handleTurn(makeMsg("other-chat", "", "hello"));

		expect(sendMock).not.toHaveBeenCalled();
		expect(enqueueMessage).not.toHaveBeenCalled();
		expect(await getConversation()).toEqual([]);
	});

	it("stays silent in setup mode until the setup code arrives", async () => {
		delete settings.basics.allowedChat;

		await handleTurn(makeMsg("new-chat", "", "hello"));

		expect(sendMock).not.toHaveBeenCalled();
		expect(enqueueMessage).not.toHaveBeenCalled();
	});

	it("dispatches /commands without invoking the model", async () => {
		const commandExecute = vi.fn(async () => {});
		commandRegistry.register({
			name: "unitcmd",
			description: "test command",
			execute: commandExecute,
		});
		const msg = makeMsg("chat1", "", "/unitcmd one two");

		await handleTurn(msg);

		expect(commandExecute).toHaveBeenCalledWith(
			expect.objectContaining({ id: msg.id, text: "/unitcmd one two" }),
			["one", "two"],
		);
		expect(sendMock).not.toHaveBeenCalled();
		// Commands are out-of-band: they don't pollute the chat history.
		expect(await getConversation()).toEqual([]);
	});

	it("does not consume /next prefix when dispatching a command", async () => {
		setNextPrefix("chat1", "@researcher !large");
		const commandExecute = vi.fn(async () => {});
		commandRegistry.register({
			name: "prefixcmd",
			description: "test command",
			execute: commandExecute,
		});

		await handleTurn(makeMsg("chat1", "", "/prefixcmd"));

		expect(commandExecute).toHaveBeenCalledOnce();
		expect(getNextPrefix("chat1")).toBe("@researcher !large");
		expect(sendMock).not.toHaveBeenCalled();
	});

	it("applies /next prefix to the next non-command message once", async () => {
		setNextPrefix("chat1", "@researcher !large");
		sendMock.mockResolvedValueOnce(replyResponse("prefixed"));

		await handleTurn(makeMsg("chat1", "", "hello from voice"));

		expect(getNextPrefix("chat1")).toBeUndefined();
		expect(firstChatRequest()).toMatchObject({
			model: defaultModel("large"),
		});
		expect(enqueueMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: "chat1",
				content: "[researcher] prefixed",
				label: "researcher",
			}),
			expect.any(Function),
		);
		expect((await getConversation())[0]).toMatchObject({
			content: "hello from voice",
			overrides: ["large"],
		});
	});

	it("resolves quoted media before dispatching /commands", async () => {
		const saved = await persistFileBlob({
			bytes: Buffer.from("source image"),
			mimeType: "image/png",
			externalId: "quoted-external",
		});
		if (saved instanceof Error) throw saved;

		const commandExecute = vi.fn(async () => {});
		commandRegistry.register({
			name: "quotecheck",
			description: "test quoted media command",
			execute: commandExecute,
		});
		const msg: InboundMessage = {
			...makeMsg("chat1", "", "/quotecheck edit this"),
			quotedMessage: {
				externalId: "quoted-external",
				text: "previous image",
			},
		};

		await handleTurn(msg);

		expect(commandExecute).toHaveBeenCalledWith(
			expect.objectContaining({
				id: msg.id,
				quotedMessage: expect.objectContaining({
					media: {
						fileId: saved.id,
						path: saved.path,
						mimeType: "image/png",
					},
				}),
			}),
			["edit", "this"],
		);
		expect(sendMock).not.toHaveBeenCalled();
		expect(await getConversation()).toEqual([]);
	});

	it("parses !overrides before routing to the model", async () => {
		sendMock.mockResolvedValueOnce(replyResponse("large send_message"));

		await handleTurn(makeMsg("chat1", "", "!large hello"));

		expect(firstChatRequest()).toMatchObject({
			model: defaultModel("large"),
		});
		expect((await getConversation())[0]).toMatchObject({
			content: "hello",
			overrides: ["large"],
		});
	});

	it("routes an @agent prefix instead of the per-chat default", async () => {
		sendMock.mockResolvedValueOnce(replyResponse("research done"));

		await handleTurn(makeMsg("chat1", "researcher", "look this up"));

		expect(enqueueMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: "chat1",
				content: "[researcher] research done",
				label: "researcher",
			}),
			expect.any(Function),
		);
	});

	it("on unhandled error: enqueues the formatted error message and applies an error reaction", async () => {
		sendMock.mockRejectedValueOnce(new Error("rate limit exceeded"));
		const msg = makeMsg("chat1", "", "please fail");

		await handleTurn(msg);

		expect(enqueueMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: "chat1",
				label: settings.whatsapp.systemLabel,
				content: expect.stringMatching(/too many requests/i),
			}),
		);
		expect(sendReaction).toHaveBeenCalledWith("chat1", msg.messageKey, "❌");
	});

	describe("per-agent turn interruption", () => {
		it("second handleTurn for same chatId+agent aborts the first", async () => {
			sendMock
				.mockImplementationOnce((_body, options?: { signal?: AbortSignal }) =>
					rejectOnAbort(options?.signal),
				)
				.mockResolvedValueOnce(replyResponse("second"));

			const p1 = handleTurn(makeMsg("chat1", "default", "A"));
			await waitForSendCalls(1);

			const p2 = handleTurn(makeMsg("chat1", "default", "B"));
			await Promise.all([p1, p2]);

			expect(sendMock).toHaveBeenCalledTimes(2);
			expect(enqueueMessage).toHaveBeenCalledOnce();
			expect(vi.mocked(enqueueMessage).mock.calls[0]?.[0]).toMatchObject({
				chatId: "chat1",
				content: "second",
				label: "default",
			});
		});

		it("rapid same-agent messages leave only the newest turn active", async () => {
			sendMock.mockImplementation(
				(body: unknown, options?: { signal?: AbortSignal }) =>
					requestUserText(body).includes("C")
						? Promise.resolve(replyResponse("third"))
						: rejectOnAbort(options?.signal),
			);

			const p1 = handleTurn(makeMsg("chat1", "default", "A"));
			await waitForSendCalls(1);

			const p2 = handleTurn(makeMsg("chat1", "default", "B"));
			const p3 = handleTurn(makeMsg("chat1", "default", "C"));
			await Promise.all([p1, p2, p3]);

			expect(enqueueMessage).toHaveBeenCalledOnce();
			expect(vi.mocked(enqueueMessage).mock.calls[0]?.[0]).toMatchObject({
				chatId: "chat1",
				content: "third",
				label: "default",
			});
		});

		it("different agents on same chat do not interrupt each other", async () => {
			sendMock
				.mockResolvedValueOnce(replyResponse("default done"))
				.mockResolvedValueOnce(replyResponse("researcher done"));

			const p1 = handleTurn(makeMsg("chat1", "default", "A"));
			await waitForSendCalls(1);

			const p2 = handleTurn(makeMsg("chat1", "researcher", "B"));
			await Promise.all([p1, p2]);

			expect(sendMock).toHaveBeenCalledTimes(2);
			expect(enqueueMessage).toHaveBeenCalledTimes(2);
			expect(vi.mocked(enqueueMessage).mock.calls.map((c) => c[0])).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						chatId: "chat1",
						content: "default done",
						label: "default",
					}),
					expect.objectContaining({
						chatId: "chat1",
						content: "[researcher] researcher done",
						label: "researcher",
					}),
				]),
			);
		});
	});
});

function makeAgent(name: string, dir: string, report = false): AgentDefinition {
	const promptPath = path.join(dir, `${name}.md`);
	writeFileSync(
		promptPath,
		`---\nname: ${name}\ntools: [send_message, probe]\nreport: ${report}\nstepLimit: 1\n---\nYou are ${name}.`,
	);
	const parsed = AgentSchema.parse({
		name,
		tools: ["send_message", "probe"],
		report,
		stepLimit: 1,
	});
	return { ...parsed, promptPath, prompt: { system: `You are ${name}.` } };
}

function makeMsg(
	chatId: string,
	agentRef: string,
	text: string,
): InboundMessage {
	return {
		kind: "whatsapp",
		id: crypto.randomUUID(),
		chatId,
		senderId: chatId,
		text: agentRef ? `@${agentRef} ${text}` : text,
		timestamp: new Date(),
		messageKey: {},
	};
}

function replyResponse(text: string) {
	return {
		choices: [
			{
				finishReason: "tool_calls",
				message: {
					content: "",
					toolCalls: [
						{
							id: crypto.randomUUID(),
							type: "function",
							function: {
								name: "send_message",
								arguments: JSON.stringify({ text }),
							},
						},
					],
				},
			},
		],
		usage: { promptTokens: 1, completionTokens: 1 },
	};
}

function mixedResponse(
	text: string,
	toolName: string,
	args: Record<string, unknown>,
) {
	return {
		choices: [
			{
				finishReason: "tool_calls",
				message: {
					content: "",
					toolCalls: [
						{
							id: "send_message-call",
							type: "function",
							function: {
								name: "send_message",
								arguments: JSON.stringify({ text }),
							},
						},
						{
							id: `${toolName}-call`,
							type: "function",
							function: {
								name: toolName,
								arguments: JSON.stringify(args),
							},
						},
					],
				},
			},
		],
		usage: { promptTokens: 1, completionTokens: 1 },
	};
}

function requestUserText(body: unknown): string {
	if (!isRecord(body)) return "";
	const chatRequest = body.chatRequest;
	if (!isRecord(chatRequest) || !Array.isArray(chatRequest.messages)) return "";
	const lastUser = chatRequest.messages.findLast(
		(message) => isRecord(message) && message.role === "user",
	);
	if (!isRecord(lastUser)) return "";
	return typeof lastUser.content === "string" ? lastUser.content : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stopResponse() {
	return {
		choices: [
			{
				finishReason: "stop",
				message: {
					content: "done",
					toolCalls: [],
				},
			},
		],
		usage: { promptTokens: 1, completionTokens: 1 },
	};
}

function firstChatRequest(): Record<string, unknown> {
	const call = sendMock.mock.calls[0]?.[0] as
		| { chatRequest?: Record<string, unknown> }
		| undefined;
	const request = call?.chatRequest;
	if (!request) throw new Error("Missing first chat request");
	return request;
}

async function waitForReport(agent: string) {
	for (let i = 0; i < 50; i++) {
		const report = (await readReports({ agent, days: 1 }))[0];
		if (report) return report;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`Timed out waiting for report for ${agent}`);
}

async function waitForTrace(runId: string) {
	for (let i = 0; i < 50; i++) {
		const trace = (await getTraces()).get(runId);
		if (trace) return trace;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`Timed out waiting for trace ${runId}`);
}

function rejectOnAbort(signal?: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		const abort = () => reject(new DOMException("Aborted", "AbortError"));
		if (signal?.aborted) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

async function waitForSendCalls(count: number): Promise<void> {
	for (let i = 0; i < 50; i++) {
		if (sendMock.mock.calls.length >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`Timed out waiting for ${count} chat.send call(s)`);
}
