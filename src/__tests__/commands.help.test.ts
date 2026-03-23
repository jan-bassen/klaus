import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

// ─── Mocks (must precede all imports of the modules under test) ───────────────

const mockEnqueueMessage = mock((_opts: unknown) => undefined);
mock.module("@/whatsapp/send", () => ({ enqueueMessage: mockEnqueueMessage }));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { registry } from "@/commands";
import { helpCommand } from "@/commands/help";
import { agentRegistry } from "@/core/agent";
import { flagRegistry } from "@/core/flags";
import type { AgentDefinition, InboundMessage } from "@/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		kind: "whatsapp",
		id: "msg-1",
		chatId: "user@s.whatsapp.net",
		senderId: "user@s.whatsapp.net",
		text: "/help",
		timestamp: new Date(),
		messageKey: {},
		...overrides,
	};
}

function makeAgent(
	name: string,
	tools: string[],
	toolsets?: string[],
): AgentDefinition {
	return {
		name,
		modelTier: "default",
		tools,
		toolsets: toolsets ?? [],
		providerTools: [],
		skills: [],
		promptPath: `/fake/agents/${name}.md`,
	};
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const TEST_CMD_NAME = "testcmd";
const TEST_AGENT_NAME = "testagent";

beforeAll(() => {
	registry.register({
		name: TEST_CMD_NAME,
		description: "A test command",
		execute: async () => {},
	});
	agentRegistry.set(
		TEST_AGENT_NAME,
		makeAgent(TEST_AGENT_NAME, ["reply"], ["vault"]),
	);
	flagRegistry.set("voice", {
		name: "voice",
		description: "reply as a voice note",
		prompt: "Answer as a voice message.",
	});
});

afterEach(() => {
	mockEnqueueMessage.mockClear();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/help", () => {
	test("no args: includes all three sections", async () => {
		await helpCommand.execute(makeMsg(), []);

		expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("*Commands*");
		expect(content).toContain(`/${TEST_CMD_NAME}`);
		expect(content).toContain("*Agents*");
		expect(content).toContain(`@${TEST_AGENT_NAME}`);
		expect(content).toContain("*Flags*");
		expect(content).toContain("!voice");
	});

	test("commands arg: only commands section", async () => {
		await helpCommand.execute(makeMsg(), ["commands"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("*Commands*");
		expect(content).not.toContain("*Agents*");
		expect(content).not.toContain("*Flags*");
	});

	test("agents arg: only agents section", async () => {
		await helpCommand.execute(makeMsg(), ["agents"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("*Agents*");
		expect(content).not.toContain("*Commands*");
		expect(content).not.toContain("*Flags*");
	});

	test("flags arg: only flags section", async () => {
		await helpCommand.execute(makeMsg(), ["flags"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("*Flags*");
		expect(content).not.toContain("*Commands*");
		expect(content).not.toContain("*Agents*");
	});

	test("agents section includes tools and toolsets", async () => {
		await helpCommand.execute(makeMsg(), ["agents"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("tools: reply");
		expect(content).toContain("toolsets: vault");
	});

	test("uses dedupKey based on message id", async () => {
		await helpCommand.execute(makeMsg({ id: "msg-42" }), []);

		const opts = (
			mockEnqueueMessage.mock.calls[0] as [{ dedupKey: string }]
		)[0];
		expect(opts.dedupKey).toBe("msg-42:help");
	});
});
