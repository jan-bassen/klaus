import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../../src/infra/config.ts";
import { listTimers, stopAllTimers } from "../../src/infra/store/timers.ts";
import {
	type AgentDefinition,
	AgentSchema,
} from "../../src/pipeline/agents.ts";
import { persistDynamic } from "../../src/pipeline/persistence.ts";
import {
	invalidateTemplate,
	type UserContent,
} from "../../src/pipeline/templates.ts";
import { initAllStores } from "../helpers/stores.ts";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.ts";
import { makeTurn } from "../helpers/turn.ts";

const sendMock = vi.hoisted(() => vi.fn());

function defaultModel(tier: "medium"): string {
	const provider = settings.providers[settings.defaultProvider];
	if (!provider)
		throw new Error(`Missing provider ${settings.defaultProvider}`);
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

describe("pipeline/persistence.persistDynamic", () => {
	let tmpDir: string;
	let originalApiKey: string | undefined;
	let originalPersistence: typeof settings.persistence;
	let originalTemplatesDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);

		originalApiKey = process.env.OPENROUTER_API_KEY;
		originalPersistence = structuredClone(settings.persistence);
		originalTemplatesDir = settings.vault.templatesDir;

		process.env.OPENROUTER_API_KEY = "test-key";
		settings.vault.templatesDir = path.resolve(
			process.cwd(),
			"vault/templates",
		);
		settings.persistence.minNextRun = "1s";
		settings.persistence.maxNextRun = "1h";
		settings.persistence.defaultNextRun = "15m";
		invalidateTemplate("persistence");
	});

	afterEach(() => {
		stopAllTimers();
		Object.assign(settings.persistence, originalPersistence);
		if (originalApiKey === undefined) {
			delete process.env.OPENROUTER_API_KEY;
		} else {
			process.env.OPENROUTER_API_KEY = originalApiKey;
		}
		settings.vault.templatesDir = originalTemplatesDir;
		invalidateTemplate("persistence");
		sendMock.mockReset();
		rmTmpDir(tmpDir);
	});

	it("forces the persist tool and creates a timer from the returned args", async () => {
		const started = Date.now();
		sendMock.mockResolvedValueOnce(
			chatResponse(
				persistCall({
					nextRun: "30m",
					prompt: "next objective",
					overrides: ["voice", "large"],
				}),
			),
		);

		await persistDynamic(baseInput(tmpDir));

		expect(sendMock).toHaveBeenCalledOnce();
		expect(firstChatRequest()).toMatchObject({
			model: defaultModel("medium"),
			toolChoice: { type: "function", function: { name: "persist" } },
			stream: false,
		});
		expect(firstChatRequest().messages).toEqual([
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "previous user" },
			{ role: "assistant", content: "previous assistant" },
			{ role: "user", content: "current user" },
			{ role: "assistant", content: "main reply" },
			{
				role: "user",
				content:
					"Now schedule your next run by calling the `persist` tool. Hint: choose a useful next run",
			},
		]);

		const timers = listTimers();
		expect(timers).toHaveLength(1);
		expect(timers[0]).toMatchObject({
			agentName: "persistent-agent",
			objective: "next objective",
			overrides: ["voice", "large"],
			createdBy: "persistent",
		});
		expect(Date.parse(timers[0]?.createdAt ?? "")).not.toBeNaN();
		expect(Date.parse(timers[0]?.runAt ?? "")).toBeGreaterThanOrEqual(
			started + 30 * 60 * 1_000 - 500,
		);
		expect(Date.parse(timers[0]?.runAt ?? "")).toBeLessThanOrEqual(
			Date.now() + 30 * 60 * 1_000 + 500,
		);
	});

	it("uses text-only current user content for the forced persist call", async () => {
		sendMock.mockResolvedValueOnce(
			chatResponse(
				persistCall({
					nextRun: "30m",
					prompt: "next objective",
				}),
			),
		);
		const input = baseInput(tmpDir);
		const userContent: UserContent = [
			{
				type: "image_url",
				imageUrl: { url: "data:image/png;base64,AAAABBBB" },
			},
			{ type: "text", text: "caption" },
		];

		await persistDynamic({ ...input, userContent });

		expect(firstChatRequest().messages).toContainEqual({
			role: "user",
			content: "caption",
		});
		expect(JSON.stringify(firstChatRequest())).not.toContain("AAAABBBB");
	});

	it("clamps ISO nextRun values into the configured scheduling window", async () => {
		settings.persistence.minNextRun = "10s";
		settings.persistence.maxNextRun = "20s";
		const started = Date.now();
		sendMock.mockResolvedValueOnce(
			chatResponse(
				persistCall({
					nextRun: new Date(started + 2 * 60 * 60 * 1_000).toISOString(),
					prompt: "clamped objective",
				}),
			),
		);

		await persistDynamic(baseInput(tmpDir));

		const runAtMs = Date.parse(listTimers()[0]?.runAt ?? "");
		expect(runAtMs).toBeGreaterThanOrEqual(started + 20_000 - 500);
		expect(runAtMs).toBeLessThanOrEqual(Date.now() + 20_000 + 500);
	});

	it("falls back to defaultNextRun when nextRun is unparseable", async () => {
		settings.persistence.defaultNextRun = "15m";
		const started = Date.now();
		sendMock.mockResolvedValueOnce(
			chatResponse(
				persistCall({
					nextRun: "sometime after lunch",
					prompt: "fallback objective",
				}),
			),
		);

		await persistDynamic(baseInput(tmpDir));

		const runAtMs = Date.parse(listTimers()[0]?.runAt ?? "");
		expect(runAtMs).toBeGreaterThanOrEqual(started + 15 * 60 * 1_000 - 500);
		expect(runAtMs).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1_000 + 500);
	});

	it("omits empty overrides instead of storing an empty array", async () => {
		sendMock.mockResolvedValueOnce(
			chatResponse(
				persistCall({
					nextRun: "5m",
					prompt: "without overrides",
					overrides: [],
				}),
			),
		);

		await persistDynamic(baseInput(tmpDir));

		expect(listTimers()[0]).not.toHaveProperty("overrides");
	});

	it("merges agent persist overrides with tool-returned overrides", async () => {
		sendMock.mockResolvedValueOnce(
			chatResponse(
				persistCall({
					nextRun: "5m",
					prompt: "with overrides",
					overrides: ["large", "voice"],
				}),
			),
		);

		await persistDynamic({
			...baseInput(tmpDir),
			overrides: ["voice", "clean"],
		});

		expect(listTimers()[0]?.overrides).toEqual(["voice", "clean", "large"]);
	});

	it("throws and does not schedule when the forced response omits the persist tool", async () => {
		sendMock.mockResolvedValueOnce(chatResponse());

		await expect(persistDynamic(baseInput(tmpDir))).rejects.toThrow(
			"@persistent-agent: persist tool was not called",
		);
		expect(listTimers()).toEqual([]);
	});
});

function baseInput(tmpDir: string) {
	const def = makeAgent(tmpDir);
	const turn = makeTurn({
		agent: def,
		chatId: "chat-1",
		config: { report: false },
	});
	return {
		def,
		turn,
		system: "system prompt",
		historyMessages: [
			{ role: "user" as const, content: "previous user" },
			{ role: "assistant" as const, content: "previous assistant" },
		],
		userContent: "current user",
		replyContent: "main reply",
		hint: "choose a useful next run",
		overrides: [],
	};
}

function makeAgent(tmpDir: string): AgentDefinition {
	const parsed = AgentSchema.parse({
		name: "persistent-agent",
		report: false,
		persist: true,
		persistHint: "choose a useful next run",
	});
	return {
		...parsed,
		promptPath: path.join(tmpDir, "persistent-agent.md"),
		prompt: { system: "system prompt" },
	};
}

function chatResponse(toolCall?: ReturnType<typeof persistCall>) {
	return {
		choices: [
			{
				index: 0,
				finishReason: toolCall ? "tool_calls" : "stop",
				message: {
					role: "assistant",
					content: "",
					toolCalls: toolCall ? [toolCall] : [],
				},
			},
		],
		usage: { promptTokens: 1, completionTokens: 1 },
	};
}

function persistCall(args: {
	nextRun: string;
	prompt: string;
	overrides?: string[];
}) {
	return {
		id: "persist-call",
		type: "function",
		function: {
			name: "persist",
			arguments: JSON.stringify(args),
		},
	};
}

function firstChatRequest(): Record<string, unknown> {
	const call = sendMock.mock.calls[0]?.[0] as
		| { chatRequest?: Record<string, unknown> }
		| undefined;
	const request = call?.chatRequest;
	if (!request) throw new Error("Missing chat request");
	return request;
}
