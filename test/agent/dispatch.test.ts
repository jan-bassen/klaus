import { beforeEach, describe, expect, test, vi } from "vitest";
import { settings } from "@/config";
import type { AgentDefinition, DispatchOptions } from "@/types";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	mockAssembleVariables: vi.fn(async () => ({})),
	mockEnqueueJob: vi.fn(() => {}),
	mockSetWorker: vi.fn(() => {}),
	mockLogInfo: vi.fn(() => {}),
	mockLogWarn: vi.fn(() => {}),
	mockLogError: vi.fn(() => {}),
	mockLogDebug: vi.fn(() => {}),
	mockRunAgent: vi.fn(async () => ({
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
	})),
	mockGetOrLoadAgent: vi.fn(
		async (_name: string): Promise<AgentDefinition> => ({
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
	),
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

vi.mock("@/agent/runner", () => ({
	runAgent: mocks.mockRunAgent,
}));

vi.mock("@/agent/definitions", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/agent/definitions")>();
	return {
		...actual,
		// dispatch calls getOrLoadAgent — mocking it lets tests assert how
		// often dispatch re-resolves the agent when cache misses.
		getOrLoadAgent: mocks.mockGetOrLoadAgent,
	};
});

const { dispatch } = await import("@/agent/dispatch");
const { agentRegistry } = await import("@/agent/definitions");

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
	mocks.mockRunAgent.mockClear();
	mocks.mockGetOrLoadAgent.mockClear();
	mocks.mockAssembleVariables.mockClear();
	mocks.mockEnqueueJob.mockClear();
	agentRegistry.clear();
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("dispatch", () => {
	test("inline mode calls runAgent and returns undefined", async () => {
		const result = await dispatch(makeOpts({ mode: { kind: "inline" } }));
		expect(result).toBeUndefined();
		expect(mocks.mockRunAgent).toHaveBeenCalledTimes(1);
		expect(mocks.mockEnqueueJob).not.toHaveBeenCalled();
	});

	test("async mode enqueues job and returns undefined", async () => {
		const result = await dispatch(makeOpts({ mode: { kind: "async" } }));
		expect(result).toBeUndefined();
		expect(mocks.mockEnqueueJob).toHaveBeenCalledTimes(1);
		expect(mocks.mockRunAgent).not.toHaveBeenCalled();
	});

	test("max chain depth returns undefined without running", async () => {
		const result = await dispatch(
			makeOpts({ depth: settings.dispatch.maxChainDepth }),
		);
		expect(result).toBeUndefined();
		expect(mocks.mockRunAgent).not.toHaveBeenCalled();
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
		expect(mocks.mockGetOrLoadAgent).toHaveBeenCalledTimes(1);
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
		expect(mocks.mockGetOrLoadAgent).not.toHaveBeenCalled();
		expect(mocks.mockRunAgent).toHaveBeenCalledTimes(1);
	});
});
