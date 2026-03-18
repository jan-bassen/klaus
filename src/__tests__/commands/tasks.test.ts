import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { InboundMessage } from "@/types";

const mockEnqueueMessage = mock((_opts: unknown) => undefined);
mock.module("@/whatsapp/send", () => ({ enqueueMessage: mockEnqueueMessage }));

const mockListTasks = mock(async () => [] as unknown[]);
mock.module("@/store/tasks", () => ({
	listTasks: mockListTasks,
	createTask: mock(async () => "id"),
	moveTask: mock(async () => {}),
	getTask: mock(async () => null),
	recoverRunningTasks: mock(async () => {}),
}));

import { tasksCommand } from "@/commands/tasks";

function makeMsg(chatId = "user@s.whatsapp.net"): InboundMessage {
	return {
		kind: "whatsapp",
		id: crypto.randomUUID(),
		chatId,
		senderId: chatId,
		timestamp: new Date(),
		messageKey: {},
	};
}

beforeEach(() => {
	mockEnqueueMessage.mockClear();
	mockListTasks.mockClear();
});

describe("/tasks", () => {
	test('sends "No active tasks." when list is empty', async () => {
		const msg = makeMsg();
		await tasksCommand.execute(msg, []);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toBe("No active tasks.");
	});

	test("formats task list with count in header", async () => {
		mockListTasks.mockResolvedValue([
			{
				id: "1",
				assignedTo: "memorize",
				objective: "Remember meeting notes",
				createdAt: new Date("2026-01-01T14:02:00Z").toISOString(),
			},
			{
				id: "2",
				assignedTo: "thinking",
				objective: "Research quantum computing",
				createdAt: new Date("2026-01-01T09:45:00Z").toISOString(),
			},
		]);

		const msg = makeMsg();
		await tasksCommand.execute(msg, []);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toMatch(/active tasks/i);
		expect(content).toContain("2");
		expect(content).toContain("memorize");
		expect(content).toContain("Remember meeting notes");
		expect(content).toContain("thinking");
		expect(content).toContain("Research quantum computing");
	});

	test('falls back to "unknown" when assignedTo is null', async () => {
		mockListTasks.mockResolvedValue([
			{
				id: "1",
				assignedTo: null,
				objective: "Some task",
				createdAt: new Date().toISOString(),
			},
		]);

		const msg = makeMsg();
		await tasksCommand.execute(msg, []);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("unknown");
	});

	test("sends error fallback when store throws", async () => {
		mockListTasks.mockRejectedValue(new Error("Store down"));

		const msg = makeMsg();
		await tasksCommand.execute(msg, []);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toMatch(/could not load/i);
	});
});
