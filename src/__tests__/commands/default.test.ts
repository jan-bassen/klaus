import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { InboundMessage } from "@/types";

const mockEnqueueMessage = mock((_opts: unknown) => undefined);
mock.module("@/whatsapp/send", () => ({ enqueueMessage: mockEnqueueMessage }));

const mockAgentRegistry = new Map<string, unknown>();
const mockLoadAgentDefinition = mock((_path: string): Promise<unknown> => {
	return Promise.reject(new Error("not found"));
});
mock.module("@/core/agent", () => ({
	agentRegistry: mockAgentRegistry,
	loadAgentDefinition: mockLoadAgentDefinition,
}));

const mockSetDefaultAgent = mock(
	(_chatId: string, _agent: string | null) => undefined,
);
mock.module("@/core/defaults", () => ({
	setDefaultAgent: mockSetDefaultAgent,
}));

import { defaultCommand } from "@/commands/default";

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
	mockLoadAgentDefinition.mockClear();
	mockSetDefaultAgent.mockClear();
	mockAgentRegistry.clear();
	// Default: loadAgentDefinition throws (agent not found on disk)
	mockLoadAgentDefinition.mockImplementation(async () => {
		throw new Error("not found");
	});
});

describe("/default", () => {
	test("sends usage hint when no args provided", async () => {
		const msg = makeMsg();
		await defaultCommand.execute(msg, []);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("Usage");
		expect(mockSetDefaultAgent).not.toHaveBeenCalled();
	});

	test("sets default from registry when agent is registered", async () => {
		mockAgentRegistry.set("thinking", { name: "thinking" });
		const msg = makeMsg();
		await defaultCommand.execute(msg, ["thinking"]);

		expect(mockSetDefaultAgent).toHaveBeenCalledWith(msg.chatId, "thinking");
		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("@thinking");
	});

	test("does not call loadAgentDefinition when agent is in registry", async () => {
		mockAgentRegistry.set("thinking", { name: "thinking" });
		const msg = makeMsg();
		await defaultCommand.execute(msg, ["thinking"]);

		expect(mockLoadAgentDefinition).not.toHaveBeenCalled();
	});

	test("falls back to file load when agent not in registry", async () => {
		const fakeDef = { name: "custom" };
		mockLoadAgentDefinition.mockResolvedValue(fakeDef);
		const msg = makeMsg();
		await defaultCommand.execute(msg, ["custom"]);

		expect(mockLoadAgentDefinition).toHaveBeenCalled();
		expect(mockSetDefaultAgent).toHaveBeenCalledWith(msg.chatId, "custom");
		expect(mockAgentRegistry.has("custom")).toBe(true);
		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("@custom");
	});

	test("sends unknown agent error when file load fails", async () => {
		const msg = makeMsg();
		await defaultCommand.execute(msg, ["nonexistent"]);

		expect(mockSetDefaultAgent).not.toHaveBeenCalled();
		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain('"nonexistent"');
	});
});
