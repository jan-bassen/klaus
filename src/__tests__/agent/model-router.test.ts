import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ModelMessage } from "ai";
import { resolveProvider, settings } from "@/config";

// ---- Mocks (must be set up before any import of the module under test) ----

const mockGenerateText = mock(async (_opts: Record<string, unknown>) => ({
	text: "Hello from the model",
	steps: [
		{
			usage: { inputTokens: 100, outputTokens: 50 },
			reasoningText: undefined,
			toolCalls: [],
			toolResults: [],
		},
	],
}));

const mockStepCountIs = mock((n: number) => ({ __stepCount: n }));

mock.module("ai", () => ({
	generateText: mockGenerateText,
	embed: mock(async () => ({ embedding: [], usage: { tokens: 0 } })),
	stepCountIs: mockStepCountIs,
	tool: mock((opts: unknown) => opts),
}));
mock.module("@/config/providers", () => ({
	createModel: mock((sdk: string, id: string) => ({ sdk, id })),
}));

import { _resetForTest } from "@/pipeline/rate-limit";

const { callModel } = await import("@/agent/model");

// ---- Helpers ----

const BASE_OPTS = {
	tier: "medium" as const,
	chatId: "user@s.whatsapp.net",
	messages: [{ role: "user", content: "hi" }] as ModelMessage[],
};

beforeEach(() => {
	_resetForTest();
	mockGenerateText.mockClear();
});

// ---- Tests ----

describe("callModel", () => {
	test("returns model text as content", async () => {
		const result = await callModel(BASE_OPTS);
		expect(result.content).toBe("Hello from the model");
	});

	test("aggregates inputTokens → promptTokens across steps", async () => {
		mockGenerateText.mockImplementationOnce(async () => ({
			text: "ok",
			steps: [
				{
					usage: { inputTokens: 200, outputTokens: 30 },
					reasoningText: undefined,
					toolCalls: [],
					toolResults: [],
				},
				{
					usage: { inputTokens: 50, outputTokens: 10 },
					reasoningText: undefined,
					toolCalls: [],
					toolResults: [],
				},
			],
		}));
		const result = await callModel(BASE_OPTS);
		expect(result.usage.promptTokens).toBe(250);
		expect(result.usage.completionTokens).toBe(40);
	});

	test("returns durationMs", async () => {
		const result = await callModel(BASE_OPTS);
		expect(typeof result.durationMs).toBe("number");
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("throws when LLM rate limit is exceeded", async () => {
		for (let i = 0; i < settings.rateLimits.modelCalls.max; i++) {
			await callModel(BASE_OPTS);
		}
		await expect(callModel(BASE_OPTS)).rejects.toThrow(
			"LLM rate limit exceeded",
		);
	});

	test("uses the model ID from config for the requested tier", async () => {
		const provider = resolveProvider();
		for (const tier of ["medium", "large", "small"] as const) {
			mockGenerateText.mockClear();
			await callModel({ ...BASE_OPTS, tier });
			const [modelArg] = mockGenerateText.mock.calls[0] ?? [];
			expect((modelArg as { model: { id: string } }).model.id).toBe(
				provider[tier],
			);
		}
	});

	test("each tier resolves to a distinct model ID", () => {
		const provider = resolveProvider();
		expect(provider.medium).not.toBe(provider.large);
		expect(provider.medium).not.toBe(provider.small);
		expect(provider.large).not.toBe(provider.small);
	});

	test("passes system prompt when provided", async () => {
		await callModel({ ...BASE_OPTS, system: "You are a test agent." });
		const [opts] = mockGenerateText.mock.calls[0] ?? [];
		expect((opts as { system?: string }).system).toBe("You are a test agent.");
	});

	test("passes tools and stopWhen when tools provided", async () => {
		const fakeTools = {
			reply: {
				description: "Reply",
				parameters: {},
				execute: async () => "sent",
			},
		};
		await callModel({ ...BASE_OPTS, tools: fakeTools as never });
		const [opts] = mockGenerateText.mock.calls[0] ?? [];
		expect((opts as { stopWhen?: unknown }).stopWhen).toEqual({
			__stepCount: 10,
		});
	});

	test("does not set stopWhen when no tools provided", async () => {
		await callModel(BASE_OPTS);
		const [opts] = mockGenerateText.mock.calls[0] ?? [];
		expect((opts as { stopWhen?: unknown }).stopWhen).toBeUndefined();
	});
});
