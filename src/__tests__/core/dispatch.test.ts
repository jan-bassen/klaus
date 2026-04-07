import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { settings } from "@/settings";
import type { AgentDefinition, DispatchOptions } from "@/types";

// ─── mocks (avoid mock.module('@/core/agent') — it poisons agent.test.ts) ───

const mockAssembleContext = mock(async () => ({
	vars: {},
	userVars: {},
	messageRefs: {},
	totalTokens: 0,
}));
mock.module("@/core/assemble", () => ({
	assembleContext: mockAssembleContext,
}));

const mockEnqueueJob = mock(() => {});
mock.module("@/core/queue", () => ({
	enqueueJob: mockEnqueueJob,
}));

mock.module("@/logger", () => ({
	log: {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
	},
}));

// Import after mocks, then install test seams for agent functions
const { dispatch, _setDispatchSeamsForTest, _clearDispatchSeamsForTest } =
	await import("@/core/dispatch");
const { agentRegistry, runAgent, loadAgentDefinition } = await import(
	"@/core/agent"
);

const mockRunAgent = mock(async () => {});
const mockLoadAgentDefinition = mock(
	async (_path: string): Promise<AgentDefinition> => ({
		name: "helper",
		modelTier: "default",
		tools: [],
		toolsets: [],
		providerTools: [],
		skills: [],
		persistent: false,
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
	mockAssembleContext.mockClear();
	mockEnqueueJob.mockClear();
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
		expect(mockEnqueueJob).not.toHaveBeenCalled();
	});

	test("async mode enqueues job and returns undefined", async () => {
		const result = await dispatch(makeOpts({ mode: { kind: "async" } }));
		expect(result).toBeUndefined();
		expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
		expect(mockRunAgent).not.toHaveBeenCalled();
	});

	test("max chain depth returns undefined without running", async () => {
		const result = await dispatch(
			makeOpts({ depth: settings.dispatch.maxChainDepth }),
		);
		expect(result).toBeUndefined();
		expect(mockRunAgent).not.toHaveBeenCalled();
		expect(mockEnqueueJob).not.toHaveBeenCalled();
	});

	test("async dispatch passes depth+1 in the enqueued payload", async () => {
		await dispatch(makeOpts({ mode: { kind: "async" }, depth: 3 }));
		const payload = (mockEnqueueJob.mock.calls[0] as unknown[])[0] as {
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
			modelTier: "default",
			tools: [],
			toolsets: [],
			providerTools: [],
			skills: [],
			persistent: false,
			promptPath: "/agents/helper.md",
		};
		agentRegistry.set("helper", cached);

		await dispatch(makeOpts({ mode: { kind: "inline" } }));
		expect(mockLoadAgentDefinition).not.toHaveBeenCalled();
		expect(mockRunAgent).toHaveBeenCalledTimes(1);
	});
});
