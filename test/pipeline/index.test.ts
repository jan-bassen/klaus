/**
 * End-to-end happy path through `handleTurn`.
 *
 * Setup strategy:
 *   - Mock `@/infra/whatsapp/send` so `enqueueMessage` becomes a spy.
 *   - Mock `@openrouter/sdk` so `new OpenRouter(...).chat.send` returns
 *     canned `ChatResult` payloads with a single `reply` tool call.
 *   - `initAllStores(tmpDir)` in beforeEach; point `settings.basics.allowedChatId`
 *     at a known chatId (mutate the live `settings` object from `@/infra/config`
 *     directly in beforeEach, or use `vi.resetModules` + dynamic import).
 *   - Register the `reply` tool and a minimal agent manually (bypass glob load).
 *
 * Universal gotcha: `@/infra/logger` eagerly reads settings — `test/setup.ts`
 * preloads `@/infra/config` to avoid the crash. Don't reorder.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "@/infra/config";
import type { InboundMessage } from "@/infra/whatsapp/receive";
import { enqueueMessage } from "@/infra/whatsapp/send";
import type { AgentDefinition } from "@/pipeline/agents";
import { AgentSchema, agentRegistry, setDefaultAgent } from "@/pipeline/agents";
import { handleTurn } from "@/pipeline/index";
import { registerTool } from "@/primitives/tools";
import { replyTool } from "@/primitives/tools/reply";
import { initAllStores } from "../helpers/stores";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("@openrouter/sdk", () => ({
	OpenRouter: vi.fn(() => ({
		chat: {
			send: sendMock,
		},
	})),
}));

vi.mock("@/infra/whatsapp/send", () => ({
	enqueueMessage: vi.fn(),
	sendReaction: vi.fn(),
}));

vi.mock("@/infra/whatsapp/presence", () => ({
	startTyping: vi.fn(),
	stopTyping: vi.fn(),
}));

describe("pipeline/index.handleTurn", () => {
	let tmpDir: string;
	let originalAllowedChatId: string | undefined;
	let originalTemplatesDir: string;
	let originalApiKey: string | undefined;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);

		originalAllowedChatId = settings.basics.allowedChatId;
		originalTemplatesDir = settings.vault.templatesDir;
		originalApiKey = process.env.OPENROUTER_API_KEY;

		settings.basics.allowedChatId = "chat1";
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

		registerTool(replyTool);
		agentRegistry.set("default", makeAgent("default", tmpDir));
		agentRegistry.set("researcher", makeAgent("researcher", tmpDir));
		setDefaultAgent("chat1", "default");
	});

	afterEach(() => {
		setDefaultAgent("chat1", null);
		settings.vault.templatesDir = originalTemplatesDir;
		if (originalAllowedChatId === undefined) {
			delete settings.basics.allowedChatId;
		} else {
			settings.basics.allowedChatId = originalAllowedChatId;
		}
		if (originalApiKey === undefined) {
			delete process.env.OPENROUTER_API_KEY;
		} else {
			process.env.OPENROUTER_API_KEY = originalApiKey;
		}
		sendMock.mockReset();
		vi.mocked(enqueueMessage).mockReset();
		rmTmpDir(tmpDir);
	});

	it.todo(
		"routes a text message to the agent and enqueues the assistant reply",
	);

	it.todo(
		"persists both user and assistant rows to the conversation JSONL (assistant carries agent + runId)",
	);

	it.todo(
		"persists a trace row with matching runId + trigger.kind === 'message'",
	);

	it.todo(
		"writes a report entry to {dataDir}/logs/*.jsonl at the default level ('agent')",
	);

	it.todo(
		"rejects messages from non-allowlisted chatIds (no enqueue, warn logged)",
	);

	it.todo(
		"enters setup mode when allowedChatId is unset (replies with setup instructions)",
	);

	it.todo(
		"dispatches /commands without invoking the model (command.execute is called)",
	);

	it.todo(
		"parses !overrides from text (!large → turn.config.modelTier === 'large')",
	);

	it.todo(
		"routes to @agent prefix when present (overrides the per-chat default)",
	);

	it.todo(
		"resolves quoted media: reply to a message with an image carries the image through",
	);

	it.todo(
		"on unhandled error: enqueues the formatted error message + applies ❌ reaction",
	);

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
					JSON.stringify(body).includes("C")
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

function makeAgent(name: string, dir: string): AgentDefinition {
	const promptPath = path.join(dir, `${name}.md`);
	writeFileSync(
		promptPath,
		`---\nname: ${name}\ntools: [reply]\nsettings:\n  report: none\n  stepLimit: 1\n---\nYou are ${name}.`,
	);
	const parsed = AgentSchema.parse({
		name,
		tools: ["reply"],
		settings: { report: "none", stepLimit: 1 },
	});
	return { ...parsed, promptPath };
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

function replyResponse(content: string) {
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
								name: "reply",
								arguments: JSON.stringify({ content }),
							},
						},
					],
				},
			},
		],
		usage: { promptTokens: 1, completionTokens: 1 },
	};
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
