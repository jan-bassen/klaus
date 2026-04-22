import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

// ─── Mocks (must precede all imports of the modules under test) ───────────────

const mocks = vi.hoisted(() => ({
	mockEnqueueMessage: vi.fn((_opts: unknown) => undefined),
	mockGetVariables: vi.fn(() => [
		{
			key: "time",
			description: "Date, time, and weekday",
			run: async () => ({}),
		},
		{
			key: "tasks",
			description: "Running jobs and pending timers",
			run: async () => ({}),
		},
		{
			key: "dispatch",
			description: "Dispatch caller, objective, and mode",
			hidden: true,
			run: async () => null,
		},
	]),
}));

vi.mock("@/whatsapp/send", () => ({
	enqueueMessage: mocks.mockEnqueueMessage,
}));

vi.mock("@/variables", () => ({
	getVariables: mocks.mockGetVariables,
	setVariables: () => {},
	loadVariables: async () => [],
	assembleVariables: async () => ({}),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { agentRegistry } from "@/agent/definitions";
import { registry } from "@/commands";
import { helpCommand } from "@/commands/help";
import { overrideRegistry } from "@/pipeline/overrides";
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
		aliases: [],
		modelTier: "medium",
		tools,
		toolsets: toolsets ?? [],
		providerTools: [],
		skills: [],
		persistent: false,
		showToolsInContext: true,
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
	overrideRegistry.set("voice", {
		name: "voice",
		description: "reply as a voice note",
		overrides: { forceVoice: true },
	});
});

afterEach(() => {
	mocks.mockEnqueueMessage.mockClear();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/help", () => {
	test("no args: includes all five sections", async () => {
		await helpCommand.execute(makeMsg(), []);

		expect(mocks.mockEnqueueMessage).toHaveBeenCalledTimes(1);
		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("*Commands*");
		expect(content).toContain(`/${TEST_CMD_NAME}`);
		expect(content).toContain("*Agents*");
		expect(content).toContain(`@${TEST_AGENT_NAME}`);
		expect(content).toContain("*overrides*");
		expect(content).toContain("!voice");
		expect(content).toContain("*Variables*");
		expect(content).toContain("*Vault*");
	});

	test.each([
		["commands", "*Commands*", ["*Agents*", "*overrides*"]],
		["agents", "*Agents*", ["*Commands*", "*overrides*"]],
		["overrides", "*overrides*", ["*Commands*", "*Agents*"]],
		["vars", "*Variables*", ["*Commands*", "*Agents*"]],
		["vault", "*Vault*", ["*Commands*", "*Agents*"]],
	] as const)("/help %s shows only that section", async (arg, expected, absent) => {
		await helpCommand.execute(makeMsg(), [arg]);

		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain(expected);
		for (const a of absent) expect(content).not.toContain(a);
	});

	test("uses dedupKey based on message id", async () => {
		await helpCommand.execute(makeMsg({ id: "msg-42" }), []);

		const opts = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ dedupKey: string }]
		)[0];
		expect(opts.dedupKey).toBe("msg-42:help");
	});
});
