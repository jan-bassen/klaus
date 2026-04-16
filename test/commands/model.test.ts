import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ─── Mocks (must precede all imports of the modules under test) ───────────────

const mocks = vi.hoisted(() => ({
	mockEnqueueMessage: vi.fn((_opts: unknown) => undefined),
}));

vi.mock("@/whatsapp/send", () => ({
	enqueueMessage: mocks.mockEnqueueMessage,
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { _resetDefaultsForTest, agentRegistry } from "@/agent";
import { modelCommand } from "@/commands/model";
import type { AgentDefinition, InboundMessage } from "@/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		kind: "whatsapp",
		id: "msg-1",
		chatId: "user@s.whatsapp.net",
		senderId: "user@s.whatsapp.net",
		text: "/model",
		timestamp: new Date(),
		messageKey: {},
		...overrides,
	};
}

const AGENT_FILE = join(tmpdir(), `test-agent-${Date.now()}.md`);

const AGENT_CONTENT = `---
name: assistant
modelTier: medium
tools: [reply]
toolsets: []
providerTools: []
skills: []
---
You are a helpful assistant.
`;

function makeAgent(tier: AgentDefinition["modelTier"]): AgentDefinition {
	return {
		name: "assistant",
		aliases: [],
		modelTier: tier,
		tools: ["reply"],
		toolsets: [],
		providerTools: [],
		skills: [],
		persistent: false,
		showToolsInContext: true,
		promptPath: AGENT_FILE,
	};
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
	writeFileSync(AGENT_FILE, AGENT_CONTENT);
	agentRegistry.set("assistant", makeAgent("medium"));
	_resetDefaultsForTest();
	mocks.mockEnqueueMessage.mockClear();
});

afterEach(() => {
	agentRegistry.delete("assistant");
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/model", () => {
	test("switch to large tier", async () => {
		await modelCommand.execute(makeMsg(), ["large"]);

		expect(mocks.mockEnqueueMessage).toHaveBeenCalledTimes(1);
		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("tier: large");

		// Registry updated
		expect(agentRegistry.get("assistant")?.modelTier).toBe("large");

		// File updated
		const raw = readFileSync(AGENT_FILE, "utf-8");
		expect(raw).toContain("modelTier: large");
	});

	test("same tier is a no-op", async () => {
		await modelCommand.execute(makeMsg(), ["medium"]);

		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("Already using");
	});

	test("unknown tier or provider returns error", async () => {
		await modelCommand.execute(makeMsg(), ["turbo"]);

		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("Unknown tier or provider");
	});

	test("unknown agent returns error", async () => {
		agentRegistry.delete("assistant");
		await modelCommand.execute(makeMsg(), ["large"]);

		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("not found");
	});

	test("switch provider by name", async () => {
		await modelCommand.execute(makeMsg(), ["chatgpt"]);

		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("chatgpt");
		expect(content).toContain("provider");
	});
});
