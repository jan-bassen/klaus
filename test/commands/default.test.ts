import { beforeEach, describe, expect, test, vi } from "vitest";
import type { InboundMessage } from "@/types";

const mocks = vi.hoisted(() => ({
	mockEnqueueMessage: vi.fn((_opts: unknown) => undefined),
	mockAgentRegistry: new Map<string, unknown>(),
	mockLoadAgentDefinition: vi.fn((_path: string): Promise<unknown> => {
		return Promise.reject(new Error("not found"));
	}),
	mockSetDefaultAgent: vi.fn(
		(_chatId: string, _agent: string | null) => undefined,
	),
}));

vi.mock("@/whatsapp/send", () => ({
	enqueueMessage: mocks.mockEnqueueMessage,
}));

vi.mock("@/agent", () => ({
	agentRegistry: mocks.mockAgentRegistry,
	loadAgentDefinition: mocks.mockLoadAgentDefinition,
	setDefaultAgent: mocks.mockSetDefaultAgent,
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
	mocks.mockEnqueueMessage.mockClear();
	mocks.mockLoadAgentDefinition.mockClear();
	mocks.mockSetDefaultAgent.mockClear();
	mocks.mockAgentRegistry.clear();
	// Default: loadAgentDefinition throws (agent not found on disk)
	mocks.mockLoadAgentDefinition.mockImplementation(async () => {
		throw new Error("not found");
	});
});

describe("/default", () => {
	test("sends usage hint when no args provided", async () => {
		const msg = makeMsg();
		await defaultCommand.execute(msg, []);

		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("Usage");
		expect(mocks.mockSetDefaultAgent).not.toHaveBeenCalled();
	});

	test("sets default from registry when agent is registered", async () => {
		mocks.mockAgentRegistry.set("thinking", { name: "thinking" });
		const msg = makeMsg();
		await defaultCommand.execute(msg, ["thinking"]);

		expect(mocks.mockSetDefaultAgent).toHaveBeenCalledWith(
			msg.chatId,
			"thinking",
		);
		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("@thinking");
	});

	test("does not call loadAgentDefinition when agent is in registry", async () => {
		mocks.mockAgentRegistry.set("thinking", { name: "thinking" });
		const msg = makeMsg();
		await defaultCommand.execute(msg, ["thinking"]);

		expect(mocks.mockLoadAgentDefinition).not.toHaveBeenCalled();
	});

	test("falls back to file load when agent not in registry", async () => {
		const fakeDef = { name: "custom" };
		mocks.mockLoadAgentDefinition.mockResolvedValue(fakeDef);
		const msg = makeMsg();
		await defaultCommand.execute(msg, ["custom"]);

		expect(mocks.mockLoadAgentDefinition).toHaveBeenCalled();
		expect(mocks.mockSetDefaultAgent).toHaveBeenCalledWith(
			msg.chatId,
			"custom",
		);
		expect(mocks.mockAgentRegistry.has("custom")).toBe(true);
		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("@custom");
	});

	test("sends unknown agent error when file load fails", async () => {
		const msg = makeMsg();
		await defaultCommand.execute(msg, ["nonexistent"]);

		expect(mocks.mockSetDefaultAgent).not.toHaveBeenCalled();
		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain('"nonexistent"');
	});
});
