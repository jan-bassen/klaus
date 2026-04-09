import { describe, expect, test } from "bun:test";
import { dispatchContextQuery } from "@/context/dispatch";
import type { AgentDefinition, TurnContext } from "@/types";

const dummyAgent: AgentDefinition = {
	name: "test",
	aliases: [],
	modelTier: "medium",
	tools: [],
	toolsets: [],
	providerTools: [],
	skills: [],
	persistent: false,
	voiceMode: "auto",
	acceptMode: "off",
	promptPath: "/dev/null",
};

function makeTurn(
	dispatchContext?: TurnContext["dispatchContext"],
	hasMessage = false,
): Omit<TurnContext, "assembled"> {
	const base: Omit<TurnContext, "assembled"> = {
		chatId: "user@s.whatsapp.net",
		agent: dummyAgent,
		flags: {},
		overrides: {},
	};
	if (dispatchContext) base.dispatchContext = dispatchContext;
	if (hasMessage) {
		(base as TurnContext).message = {
			kind: "whatsapp",
			id: "msg-1",
			chatId: "user@s.whatsapp.net",
			senderId: "user@s.whatsapp.net",
			text: "hi",
			timestamp: new Date(),
			messageKey: {},
		};
	}
	return base;
}

describe("dispatchContextQuery", () => {
	test("returns empty when no dispatch context", async () => {
		const result = await dispatchContextQuery.run(makeTurn());
		expect(result.content).toBeUndefined();
		expect(result.tokenCount).toBe(0);
	});

	test("renders basic dispatch block", async () => {
		const result = await dispatchContextQuery.run(
			makeTurn({
				caller: "klaus",
				objective: "Do the thing",
				mode: { kind: "inline" },
			}),
		);
		expect(result.content).toContain("Caller: klaus");
		expect(result.content).toContain("Objective: Do the thing");
		expect(result.content).toContain("Mode: inline");
	});

	test("includes hint when present", async () => {
		const result = await dispatchContextQuery.run(
			makeTurn({
				caller: "scheduler",
				objective: "Scheduled: morning check",
				hint: "Check weather and send summary",
				mode: { kind: "async" },
			}),
		);
		expect(result.content).toContain("Hint: Check weather and send summary");
	});

	test("omits hint line when not present", async () => {
		const result = await dispatchContextQuery.run(
			makeTurn({
				caller: "klaus",
				objective: "Do stuff",
				mode: { kind: "async" },
			}),
		);
		expect(result.content).not.toContain("Hint:");
	});

	test("appends scheduled-invocation note when no message", async () => {
		const result = await dispatchContextQuery.run(
			makeTurn(
				{
					caller: "scheduler",
					objective: "Scheduled: daily report",
					mode: { kind: "async" },
				},
				false,
			),
		);
		expect(result.content).toContain("scheduled invocation");
		expect(result.content).toContain("`react`");
		expect(result.content).toContain("`reply`");
		expect(result.content).toContain("`send`");
	});

	test("does not append scheduled-invocation note when message present", async () => {
		const result = await dispatchContextQuery.run(
			makeTurn(
				{
					caller: "klaus",
					objective: "Do stuff",
					mode: { kind: "async" },
				},
				true,
			),
		);
		expect(result.content).not.toContain("scheduled invocation");
	});
});
