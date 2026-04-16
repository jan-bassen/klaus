import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { settings } from "@/config";
import type { AgentDefinition, DispatchOptions } from "@/types";

// ─── mocks (avoid vi.mock('@/core/agent') — it poisons agent.test.ts) ───

const mocks = vi.hoisted(() => ({
	mockAssembleVariables: vi.fn(async () => ({})),
	mockEnqueueJob: vi.fn(() => {}),
	mockSetWorker: vi.fn(() => {}),
	mockLogInfo: vi.fn(() => {}),
	mockLogWarn: vi.fn(() => {}),
	mockLogError: vi.fn(() => {}),
	mockLogDebug: vi.fn(() => {}),
}));

vi.mock("@/variables", () => ({
	assembleVariables: mocks.mockAssembleVariables,
}));

vi.mock("@/agent/queue", () => ({
	enqueueJob: mocks.mockEnqueueJob,
	setWorker: mocks.mockSetWorker,
}));

vi.mock("@/logger", () => ({
	log: {
		info: mocks.mockLogInfo,
		warn: mocks.mockLogWarn,
		error: mocks.mockLogError,
		debug: mocks.mockLogDebug,
	},
}));

// Import after mocks, then install test seams for agent functions
const { dispatch, _setDispatchSeamsForTest, _clearDispatchSeamsForTest } =
	await import("@/agent/dispatch");
const { agentRegistry } = await import("@/agent");
const { runAgent } = await import("@/agent/runner");
const { loadAgentDefinition } = await import("@/agent");

const mockRunAgent = vi.fn(async () => ({
	usage: { promptTokens: 0, completionTokens: 0 },
	durationMs: 0,
	steps: [],
	model: "test-model",
	provider: "anthropic",
	tier: "medium",
	conversationMessages: 0,
	systemPrompt: "",
	userMessage: "",
	replyContent: "",
}));
const mockLoadAgentDefinition = vi.fn(
	async (_path: string): Promise<AgentDefinition> => ({
		name: "helper",
		aliases: [],
		modelTier: "medium",
		tools: [],
		toolsets: [],
		providerTools: [],
		skills: [],
		persistent: false,
		showToolsInContext: true,
		promptPath: "/agents/helper.md",
	}),
);

_setDispatchSeamsForTest({
	runAgent: mockRunAgent as typeof runAgent,
	loadAgentDefinition: mockLoadAgentDefinition as typeof loadAgentDefinition,
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeOpts(overrides: Partial<DispatchOptions> = {}): DispatchOptions {
	return {
		agent: "helper",
		objective: "Do the thing",
		mode: { kind: "async" },
		chatId: "user@s.whatsapp.net",
		caller: "klaus",
		depth: 0,
		...overrides,
	};
}

beforeEach(() => {
	mockRunAgent.mockClear();
	mockLoadAgentDefinition.mockClear();
	mocks.mockAssembleVariables.mockClear();
	mocks.mockEnqueueJob.mockClear();
	agentRegistry.clear();
});

afterEach(() => {
	_clearDispatchSeamsForTest();
	_setDispatchSeamsForTest({
		runAgent: mockRunAgent as typeof runAgent,
		loadAgentDefinition: mockLoadAgentDefinition as typeof loadAgentDefinition,
	});
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("dispatch", () => {
	test("inline mode calls runAgent and returns undefined", async () => {
		const result = await dispatch(makeOpts({ mode: { kind: "inline" } }));
		expect(result).toBeUndefined();
		expect(mockRunAgent).toHaveBeenCalledTimes(1);
		expect(mocks.mockEnqueueJob).not.toHaveBeenCalled();
	});

	test("async mode enqueues job and returns undefined", async () => {
		const result = await dispatch(makeOpts({ mode: { kind: "async" } }));
		expect(result).toBeUndefined();
		expect(mocks.mockEnqueueJob).toHaveBeenCalledTimes(1);
		expect(mockRunAgent).not.toHaveBeenCalled();
	});

	test("max chain depth returns undefined without running", async () => {
		const result = await dispatch(
			makeOpts({ depth: settings.dispatch.maxChainDepth }),
		);
		expect(result).toBeUndefined();
		expect(mockRunAgent).not.toHaveBeenCalled();
		expect(mocks.mockEnqueueJob).not.toHaveBeenCalled();
	});

	test("async dispatch passes depth+1 in the enqueued payload", async () => {
		await dispatch(makeOpts({ mode: { kind: "async" }, depth: 3 }));
		const payload = (mocks.mockEnqueueJob.mock.calls[0] as unknown[])[0] as {
			depth: number;
		};
		expect(payload.depth).toBe(4);
	});

	test("loads agent from disk when not in registry", async () => {
		await dispatch(makeOpts({ mode: { kind: "inline" } }));
		expect(mockLoadAgentDefinition).toHaveBeenCalledTimes(1);
	});

	test("uses cached agent when in registry", async () => {
		const cached: AgentDefinition = {
			name: "helper",
			aliases: [],
			modelTier: "medium",
			tools: [],
			toolsets: [],
			providerTools: [],
			skills: [],
			persistent: false,
			showToolsInContext: true,
			promptPath: "/agents/helper.md",
		};
		agentRegistry.set("helper", cached);

		await dispatch(makeOpts({ mode: { kind: "inline" } }));
		expect(mockLoadAgentDefinition).not.toHaveBeenCalled();
		expect(mockRunAgent).toHaveBeenCalledTimes(1);
	});
});
