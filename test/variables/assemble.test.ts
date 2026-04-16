import { describe, expect, test } from "vitest";
import type { AgentDefinition, TurnContext, Variable } from "@/types";
import { assembleVariables } from "@/variables";

const CHAT_ID = "user@s.whatsapp.net";

const dummyAgent: AgentDefinition = {
	name: "test",
	aliases: [],
	modelTier: "medium",
	tools: [],
	toolsets: [],
	providerTools: [],
	skills: [],
	persistent: false,
	showToolsInContext: true,
	promptPath: "/dev/null",
};

function makeTurn(
	overrides: Partial<Omit<TurnContext, "vars">> = {},
): Omit<TurnContext, "vars"> {
	return {
		chatId: CHAT_ID,
		message: {
			kind: "whatsapp",
			id: "msg-1",
			chatId: CHAT_ID,
			senderId: CHAT_ID,
			text: "hello",
			timestamp: new Date(),
			messageKey: {},
		},
		agent: dummyAgent,
		overrides: {},
		config: {},
		messageRefs: {},
		...overrides,
	};
}

describe("assembleVariables", () => {
	test("no variables → empty namespace", async () => {
		const result = await assembleVariables(makeTurn(), []);
		expect(result).toEqual({});
	});

	test("each variable's output lands at its key", async () => {
		const time: Variable = {
			key: "time",
			run: async () => ({ date: "Monday" }),
		};
		const tasks: Variable = {
			key: "tasks",
			run: async () => ({ active: [{ objective: "run" }] }),
		};
		const result = await assembleVariables(makeTurn(), [time, tasks]);
		expect(result.time).toEqual({ date: "Monday" });
		expect(result.tasks).toEqual({ active: [{ objective: "run" }] });
	});

	test("failed variable is skipped, others continue", async () => {
		const bad: Variable = {
			key: "broken",
			run: async () => {
				throw new Error("boom");
			},
		};
		const good: Variable = { key: "time", run: async () => ({ date: "x" }) };
		const result = await assembleVariables(makeTurn(), [bad, good]);
		expect(result.time).toEqual({ date: "x" });
		expect(result.broken).toBeUndefined();
	});

	test("after-variables receive the partial namespace", async () => {
		const phase1: Variable = {
			key: "config",
			run: async () => ({ provider: "claude" }),
		};
		const phase2: Variable = {
			key: "snippets",
			after: true,
			run: async (turn) => {
				const ov = (turn.vars?.config as { provider?: string }) ?? {};
				return { greeting: `hello ${ov.provider}` };
			},
		};
		const result = await assembleVariables(makeTurn(), [phase1, phase2]);
		expect(result.snippets).toEqual({ greeting: "hello claude" });
	});
});
