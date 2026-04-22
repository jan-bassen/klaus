import type { ModelMessage } from "ai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveProvider, settings } from "@/config";

// ---- Mocks (must be set up before any import of the module under test) ----

const mocks = vi.hoisted(() => ({
	mockGenerateText: vi.fn(async (_opts: Record<string, unknown>) => ({
		text: "Hello from the model",
		steps: [
			{
				usage: { inputTokens: 100, outputTokens: 50 },
				reasoningText: undefined,
				toolCalls: [],
				toolResults: [],
			},
		],
	})),
	mockStepCountIs: vi.fn((n: number) => ({ __stepCount: n })),
	mockEmbed: vi.fn(async () => ({ embedding: [], usage: { tokens: 0 } })),
	mockTool: vi.fn((opts: unknown) => opts),
	mockCreateModel: vi.fn((sdk: string, id: string) => ({ sdk, id })),
}));

vi.mock("ai", () => ({
	generateText: mocks.mockGenerateText,
	embed: mocks.mockEmbed,
	stepCountIs: mocks.mockStepCountIs,
	tool: mocks.mockTool,
}));
vi.mock("@/config/providers", () => ({
	createModel: mocks.mockCreateModel,
}));

const { callModel } = await import("@/agent/model");

// ---- Helpers ----

const BASE_OPTS = {
	tier: "medium" as const,
	chatId: "user@s.whatsapp.net",
	messages: [{ role: "user", content: "hi" }] as ModelMessage[],
};

beforeEach(() => {
	mocks.mockGenerateText.mockClear();
});

// ---- Tests ----

describe("callModel", () => {
	test("returns model text as content", async () => {
		const result = await callModel(BASE_OPTS);
		expect(result.content).toBe("Hello from the model");
	});

	test("aggregates inputTokens → promptTokens across steps", async () => {
		mocks.mockGenerateText.mockImplementationOnce(async () => ({
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
			mocks.mockGenerateText.mockClear();
			await callModel({ ...BASE_OPTS, tier });
			const [modelArg] = mocks.mockGenerateText.mock.calls[0] ?? [];
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
		const [opts] = mocks.mockGenerateText.mock.calls[0] ?? [];
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
		const [opts] = mocks.mockGenerateText.mock.calls[0] ?? [];
		expect((opts as { stopWhen?: unknown }).stopWhen).toEqual({
			__stepCount: 10,
		});
	});

	test("does not set stopWhen when no tools provided", async () => {
		await callModel(BASE_OPTS);
		const [opts] = mocks.mockGenerateText.mock.calls[0] ?? [];
		expect((opts as { stopWhen?: unknown }).stopWhen).toBeUndefined();
	});
});
