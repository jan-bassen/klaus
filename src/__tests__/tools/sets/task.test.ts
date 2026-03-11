import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentDefinition, TurnContext } from "@/types";

// ─── mocks ───────────────────────────────────────────────────────────────────

const mockDispatch = mock(
	async (): Promise<string | undefined> => "task-uuid-1",
);
mock.module("@/core/dispatch", () => ({ dispatch: mockDispatch }));

const mockCancel = mock(async () => {});
mock.module("@/core/queue", () => ({
	getQueue: () => ({ cancel: mockCancel }),
}));

// Drizzle query builders are thenable AND chainable. This mock handles both:
//   cancel: `const [task] = await db.select().from().where(...)` — awaits directly
//   list:   `db.select().from().where(...).orderBy(...).limit(20)` — chains then awaits
type ChainableQuery = Promise<unknown[]> & {
	orderBy: () => { limit: () => Promise<unknown[]> };
};
function makeChainableQuery(rows: unknown[] = []): ChainableQuery {
	const p = Promise.resolve(rows) as ChainableQuery;
	p.orderBy = () => ({ limit: mock(async () => []) });
	return p;
}
const mockSelectFromWhere = mock(() => makeChainableQuery());
const mockUpdateSetWhere = mock(async () => {});
const mockDb = {
	select: mock(() => ({
		from: mock(() => ({
			where: mockSelectFromWhere,
			orderBy: mock(() => ({
				limit: mock(async () => []),
			})),
		})),
	})),
	update: mock(() => ({
		set: mock(() => ({
			where: mockUpdateSetWhere,
		})),
	})),
};
mock.module("@/db/client", () => ({ db: mockDb }));
mock.module("@/db/schema", () => ({ tasks: {} }));

mock.module("@/logger", () => ({
	log: {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
	},
}));

const { dispatchTool, taskCancelTool, taskListTool } = await import(
	"@/tools/sets/task"
);

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
		assembled: { vars: {}, totalTokens: 0 },
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
	mockCancel.mockClear();
	mockSelectFromWhere.mockImplementation(() => makeChainableQuery());
	mockUpdateSetWhere.mockClear();
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

	test('inline mode returns "done"', async () => {
		mockDispatch.mockImplementation(async () => undefined);
		const result = await dispatchTool.execute(
			{ agent: "helper", objective: "Do stuff", mode: "inline" },
			makeContext(),
		);
		expect(result).toBe("done");
		const [opts] = mockDispatch.mock.calls[0] as unknown as [{ mode: unknown }];
		expect(opts.mode).toEqual({ kind: "inline" });
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
		mockSelectFromWhere.mockImplementation(() =>
			makeChainableQuery([{ id: "task-1", status: "pending" }]),
		);
		const result = await taskCancelTool.execute(
			{ taskId: "task-1" },
			makeContext(),
		);
		expect(result).toContain("Cancelled");
		expect(mockUpdateSetWhere).toHaveBeenCalled();
	});

	test("returns not found for missing task", async () => {
		mockSelectFromWhere.mockImplementation(() => makeChainableQuery([]));
		const result = await taskCancelTool.execute(
			{ taskId: "missing" },
			makeContext(),
		);
		expect(result).toContain("not found");
	});

	test("returns already-terminal for done task", async () => {
		mockSelectFromWhere.mockImplementation(() =>
			makeChainableQuery([{ id: "task-1", status: "done" }]),
		);
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
