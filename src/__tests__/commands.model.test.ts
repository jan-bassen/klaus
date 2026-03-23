import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Mocks (must precede all imports of the modules under test) ───────────────

const mockEnqueueMessage = mock((_opts: unknown) => undefined);
mock.module("@/whatsapp/send", () => ({ enqueueMessage: mockEnqueueMessage }));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { agentRegistry } from "@/core/agent";
import { _resetDefaultsForTest } from "@/core/defaults";
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
name: klaus
modelTier: default
tools: [reply]
toolsets: []
providerTools: []
skills: []
---
You are Klaus.
`;

function makeAgent(tier: AgentDefinition["modelTier"]): AgentDefinition {
	return {
		name: "klaus",
		modelTier: tier,
		tools: ["reply"],
		toolsets: [],
		providerTools: [],
		skills: [],
		promptPath: AGENT_FILE,
	};
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
	await Bun.write(AGENT_FILE, AGENT_CONTENT);
	agentRegistry.set("klaus", makeAgent("default"));
	_resetDefaultsForTest();
	mockEnqueueMessage.mockClear();
});

afterEach(() => {
	agentRegistry.delete("klaus");
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/model", () => {
	test("no args: shows current model", async () => {
		await modelCommand.execute(makeMsg(), []);

		expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("@klaus");
		expect(content).toContain("tier: default");
	});

	test("switch to high tier", async () => {
		await modelCommand.execute(makeMsg(), ["high"]);

		expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("tier: high");

		// Registry updated
		expect(agentRegistry.get("klaus")?.modelTier).toBe("high");

		// File updated
		const raw = await Bun.file(AGENT_FILE).text();
		expect(raw).toContain("modelTier: high");
	});

	test("same tier is a no-op", async () => {
		await modelCommand.execute(makeMsg(), ["default"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("Already using");
	});

	test("unknown tier returns error", async () => {
		await modelCommand.execute(makeMsg(), ["turbo"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("Unknown tier");
		expect(content).toContain("default, low, high");
	});

	test("unknown agent returns error", async () => {
		agentRegistry.delete("klaus");
		await modelCommand.execute(makeMsg(), ["high"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("not found");
	});
});
