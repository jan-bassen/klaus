import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { InboundMessage } from "@/types";

const mockEnqueueMessage = mock((_opts: unknown) => undefined);
mock.module("@/whatsapp/send", () => ({ enqueueMessage: mockEnqueueMessage }));

const mockGetActiveJobs = mock(() => [] as unknown[]);
mock.module("@/core/queue", () => ({
	getActiveJobs: mockGetActiveJobs,
}));

const mockGetSchedules = mock(() => [] as unknown[]);
mock.module("@/store/schedules", () => ({
	getSchedules: mockGetSchedules,
}));

const mockListTimers = mock(() => [] as unknown[]);
mock.module("@/store/timers", () => ({
	listTimers: mockListTimers,
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
	mockGetActiveJobs.mockClear();
	mockGetActiveJobs.mockImplementation(() => []);
	mockGetSchedules.mockClear();
	mockGetSchedules.mockImplementation(() => []);
	mockListTimers.mockClear();
	mockListTimers.mockImplementation(() => []);
});

describe("/tasks", () => {
	test("sends empty message when nothing active", async () => {
		const msg = makeMsg();
		await tasksCommand.execute(msg, []);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("No active");
	});

	test("formats active jobs", async () => {
		mockGetActiveJobs.mockImplementation(() => [
			{
				agentName: "memorize",
				objective: "Remember meeting notes",
				startedAt: new Date("2026-01-01T14:02:00Z").toISOString(),
			},
		]);

		const msg = makeMsg();
		await tasksCommand.execute(msg, []);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("memorize");
		expect(content).toContain("Remember meeting notes");
	});

	test("shows schedules and timers", async () => {
		mockGetSchedules.mockImplementation(() => [
			{
				id: "s-1",
				agentName: "morning",
				pattern: "0 8 * * *",
				label: "morning-check",
			},
		]);
		mockListTimers.mockImplementation(() => [
			{
				id: "t-1",
				agentName: "klaus",
				objective: "Buy milk",
				runAt: new Date("2026-03-23T17:00:00Z").toISOString(),
			},
		]);

		const msg = makeMsg();
		await tasksCommand.execute(msg, []);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("Schedules");
		expect(content).toContain("morning");
		expect(content).toContain("Timers");
		expect(content).toContain("Buy milk");
	});
});
