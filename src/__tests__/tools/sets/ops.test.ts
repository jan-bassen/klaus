import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentDefinition, TurnContext } from "@/types";

// ─── mocks ───────────────────────────────────────────────────────────────────

const mockDispatch = mock(async (): Promise<string | undefined> => undefined);
mock.module("@/core/dispatch", () => ({ dispatch: mockDispatch }));

const mockListSchedules = mock(async () => []);
const mockDeleteSchedule = mock(async () => {});
mock.module("@/core/queue", () => ({
	listSchedules: mockListSchedules,
	deleteSchedule: mockDeleteSchedule,
}));

mock.module("@/store/budgets", () => ({
	getBudget: mock(() => null),
}));

mock.module("@/store/costs", () => ({
	getCostSummary: mock(async () => ({
		periodLabel: "today",
		total: 0,
		byService: {},
	})),
}));

mock.module("@/logger", () => ({
	log: {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
	},
}));

const { opsCronTool } = await import("@/tools/sets/ops");

// ─── helpers ─────────────────────────────────────────────────────────────────

const dummyAgent: AgentDefinition = {
	name: "klaus",
	modelTier: "default",
	tools: [],
	promptPath: "/dev/null",
};

function makeContext(): TurnContext {
	return {
		chatId: "user@s.whatsapp.net",
		agent: dummyAgent,
		flags: {},
		assembled: { vars: {}, messageRefs: {}, totalTokens: 0 },
	};
}

beforeEach(() => {
	mockDispatch.mockClear();
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("opsCronTool", () => {
	test("passes hint to dispatch when provided", async () => {
		await opsCronTool.execute(
			{
				pattern: "0 8 * * *",
				agentName: "morning",
				label: "morning check",
				hint: "Check the weather and send a summary",
				oneTime: false,
			},
			makeContext(),
		);
		expect(mockDispatch).toHaveBeenCalledTimes(1);
		const [opts] = mockDispatch.mock.calls[0] as unknown as [{ hint?: string }];
		expect(opts.hint).toBe("Check the weather and send a summary");
	});

	test("passes undefined hint when not provided", async () => {
		await opsCronTool.execute(
			{
				pattern: "0 8 * * *",
				agentName: "morning",
				label: "morning check",
				oneTime: false,
			},
			makeContext(),
		);
		const [opts] = mockDispatch.mock.calls[0] as unknown as [{ hint?: string }];
		expect(opts.hint).toBeUndefined();
	});

	test("returns confirmation string", async () => {
		const result = await opsCronTool.execute(
			{
				pattern: "0 8 * * *",
				agentName: "morning",
				label: "morning check",
				oneTime: false,
			},
			makeContext(),
		);
		expect(result).toContain("morning");
		expect(result).toContain("0 8 * * *");
	});
});
