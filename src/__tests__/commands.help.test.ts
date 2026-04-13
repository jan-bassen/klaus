import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

// ─── Mocks (must precede all imports of the modules under test) ───────────────

const mockEnqueueMessage = mock((_opts: unknown) => undefined);
mock.module("@/whatsapp/send", () => ({ enqueueMessage: mockEnqueueMessage }));

const mockGetContextVariables = mock(() => [
	{
		name: "date",
		description: "Current date",
		priority: -1,
		run: async () => ({
			content: "",
			tokenCount: 0,
			truncate: "never" as const,
		}),
	},
	{
		name: "active_tasks",
		description: "Running jobs and pending timers",
		params: { limit: "max items" },
		priority: 4,
		run: async () => ({
			content: "",
			tokenCount: 0,
			truncate: "always" as const,
		}),
	},
	{
		name: "dispatch_context",
		description: "Dispatch caller and objective",
		priority: -1,
		run: async () => ({
			content: "",
			tokenCount: 0,
			truncate: "never" as const,
		}),
	},
]);
mock.module("@/core/assemble", () => ({
	getContextVariables: mockGetContextVariables,
	setContextVariables: () => {},
	loadContextVariables: async () => [],
	assembleContext: async () => ({
		vars: {},
		userVars: {},
		messageRefs: {},
		totalTokens: 0,
	}),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { registry } from "@/commands";
import { helpCommand } from "@/commands/help";
import { agentRegistry } from "@/core/agent";
import { overrideRegistry } from "@/core/overrides";
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
	mockEnqueueMessage.mockClear();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/help", () => {
	test("no args: includes all five sections", async () => {
		await helpCommand.execute(makeMsg(), []);

		expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
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

	test("commands arg: only commands section", async () => {
		await helpCommand.execute(makeMsg(), ["commands"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("*Commands*");
		expect(content).not.toContain("*Agents*");
		expect(content).not.toContain("*overrides*");
	});

	test("agents arg: only agents section", async () => {
		await helpCommand.execute(makeMsg(), ["agents"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("*Agents*");
		expect(content).not.toContain("*Commands*");
		expect(content).not.toContain("*overrides*");
	});

	test("overrides arg: only overrides section", async () => {
		await helpCommand.execute(makeMsg(), ["overrides"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("*overrides*");
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

	test("vars arg: only vars section", async () => {
		await helpCommand.execute(makeMsg(), ["vars"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("*Variables*");
		expect(content).toContain("$date");
		expect(content).toContain("$active_tasks");
		expect(content).not.toContain("*Commands*");
		expect(content).not.toContain("*Agents*");
	});

	test("vars section shows descriptions and params", async () => {
		await helpCommand.execute(makeMsg(), ["vars"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("Current date");
		expect(content).toContain("params: limit: max items");
	});

	test("vars section excludes dispatch_context", async () => {
		await helpCommand.execute(makeMsg(), ["vars"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).not.toContain("dispatch_context");
	});

	test("vault arg: only vault section", async () => {
		await helpCommand.execute(makeMsg(), ["vault"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("*Vault*");
		expect(content).not.toContain("*Commands*");
		expect(content).not.toContain("*Agents*");
	});

	test("vault section shows folders with permissions", async () => {
		await helpCommand.execute(makeMsg(), ["vault"]);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		// Checks against default schema values
		expect(content).toContain("(root)");
		expect(content).toContain("Klaus/");
	});

	test("uses dedupKey based on message id", async () => {
		await helpCommand.execute(makeMsg({ id: "msg-42" }), []);

		const opts = (
			mockEnqueueMessage.mock.calls[0] as [{ dedupKey: string }]
		)[0];
		expect(opts.dedupKey).toBe("msg-42:help");
	});
});
