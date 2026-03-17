import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentDefinition, TurnContext } from "@/types";

// ─── mocks ───────────────────────────────────────────────────────────────────

const mockDispatch = mock(
	async (): Promise<string | undefined> => "task-uuid-1",
);
mock.module("@/core/dispatch", () => ({ dispatch: mockDispatch }));

const mockGetTask = mock(
	async (_id: string) => null as { id: string; status: string } | null,
);
const mockListTasks = mock(async () => [] as unknown[]);
const mockMoveTask = mock(async () => {});

mock.module("@/store/tasks", () => ({
	getTask: mockGetTask,
	listTasks: mockListTasks,
	moveTask: mockMoveTask,
	createTask: mock(async () => "id"),
	recoverRunningTasks: mock(async () => {}),
}));

mock.module("@/logger", () => ({
	log: {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
	},
}));

const {
	taskDispatchTool: dispatchTool,
	taskCancelTool,
	taskListTool,
} = await import("@/tools/sets/tasks");

// ─── helpers ─────────────────────────────────────────────────────────────────

const dummyAgent: AgentDefinition = {
	name: "klaus",
	modelTier: "default",
	tools: [],
	promptPath: "/dev/null",
};

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
	return {
		chatId: "user@s.whatsapp.net",
		agent: dummyAgent,
		flags: {},
		assembled: {
			vars: {},
			conversationMessages: [],
			messageRefs: {},
			totalTokens: 0,
		},
		message: {
			kind: "whatsapp",
			id: "msg-1",
			chatId: "user@s.whatsapp.net",
			senderId: "user@s.whatsapp.net",
			text: "hi",
			timestamp: new Date(),
			messageKey: {},
		},
		...overrides,
	};
}

beforeEach(() => {
	mockDispatch.mockClear();
	mockDispatch.mockImplementation(async () => "task-uuid-1");
	mockGetTask.mockClear();
	mockGetTask.mockImplementation(async () => null);
	mockListTasks.mockClear();
	mockListTasks.mockImplementation(async () => []);
	mockMoveTask.mockClear();
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("dispatchTool", () => {
	test("async mode returns dispatch result with task ID", async () => {
		const result = await dispatchTool.execute(
			{ agent: "helper", objective: "Do stuff", mode: "async" },
			makeContext(),
		);
		expect(result).toContain("task-uuid-1");
		expect(mockDispatch).toHaveBeenCalledTimes(1);
		const [opts] = mockDispatch.mock.calls[0] as unknown as [{ mode: unknown }];
		expect(opts.mode).toEqual({ kind: "async" });
	});

	test('inline mode returns "done" when subagent produces no reply', async () => {
		mockDispatch.mockImplementation(async () => undefined);
		const result = await dispatchTool.execute(
			{ agent: "helper", objective: "Do stuff", mode: "inline" },
			makeContext(),
		);
		expect(result).toBe("done");
		const [opts] = mockDispatch.mock.calls[0] as unknown as [{ mode: unknown }];
		expect(opts.mode).toEqual({ kind: "inline" });
	});

	test("inline mode returns subagent reply content", async () => {
		mockDispatch.mockImplementation(async () => "Here is the answer.");
		const result = await dispatchTool.execute(
			{ agent: "helper", objective: "Do stuff", mode: "inline" },
			makeContext(),
		);
		expect(result).toBe("Here is the answer.");
	});

	test("passes caller from context agent name", async () => {
		await dispatchTool.execute(
			{ agent: "helper", objective: "Do stuff", mode: "async" },
			makeContext(),
		);
		const [opts] = mockDispatch.mock.calls[0] as unknown as [
			{ caller: string },
		];
		expect(opts.caller).toBe("klaus");
	});
});

describe("taskCancelTool", () => {
	test("cancels a pending task", async () => {
		mockGetTask.mockImplementation(async () => ({
			id: "task-1",
			status: "pending",
		}));
		const result = await taskCancelTool.execute(
			{ taskId: "task-1" },
			makeContext(),
		);
		expect(result).toContain("Cancelled");
		expect(mockMoveTask).toHaveBeenCalled();
	});

	test("returns not found for missing task", async () => {
		mockGetTask.mockImplementation(async () => null);
		const result = await taskCancelTool.execute(
			{ taskId: "missing" },
			makeContext(),
		);
		expect(result).toContain("not found");
	});

	test("returns already-terminal for done task", async () => {
		mockGetTask.mockImplementation(async () => ({
			id: "task-1",
			status: "done",
		}));
		const result = await taskCancelTool.execute(
			{ taskId: "task-1" },
			makeContext(),
		);
		expect(result).toContain("already done");
	});
});

describe("taskListTool", () => {
	test('returns "No tasks found." when empty', async () => {
		const result = await taskListTool.execute({}, makeContext());
		expect(result).toBe("No tasks found.");
	});
});
