import { describe, expect, test } from "vitest";
import type { AgentDefinition, TurnContext } from "@/types";
import { dispatchVariable } from "@/variables/dispatch";

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
	dispatchContext?: TurnContext["dispatchContext"],
	hasMessage = false,
): Omit<TurnContext, "vars"> {
	const base: Omit<TurnContext, "vars"> = {
		chatId: "user@s.whatsapp.net",
		agent: dummyAgent,
		overrides: {},
		config: {},
		messageRefs: {},
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

type DispatchResult = {
	caller: string;
	objective: string;
	hint: string | null;
	mode: string;
	hasMessage: boolean;
} | null;

describe("dispatchVariable", () => {
	test("returns null when no dispatch context", async () => {
		const result = (await dispatchVariable.run(makeTurn())) as DispatchResult;
		expect(result).toBeNull();
	});

	test("exposes caller, objective, mode", async () => {
		const result = (await dispatchVariable.run(
			makeTurn({
				caller: "klaus",
				objective: "Do the thing",
				mode: { kind: "inline" },
			}),
		)) as DispatchResult;
		expect(result?.caller).toBe("klaus");
		expect(result?.objective).toBe("Do the thing");
		expect(result?.mode).toBe("inline");
	});

	test("exposes hint when present", async () => {
		const result = (await dispatchVariable.run(
			makeTurn({
				caller: "scheduler",
				objective: "Scheduled check",
				hint: "Check weather",
				mode: { kind: "async" },
			}),
		)) as DispatchResult;
		expect(result?.hint).toBe("Check weather");
	});

	test("hint is null when not provided", async () => {
		const result = (await dispatchVariable.run(
			makeTurn({
				caller: "klaus",
				objective: "Do stuff",
				mode: { kind: "async" },
			}),
		)) as DispatchResult;
		expect(result?.hint).toBeNull();
	});

	test("hasMessage=false when no message is present", async () => {
		const result = (await dispatchVariable.run(
			makeTurn(
				{
					caller: "scheduler",
					objective: "tick",
					mode: { kind: "async" },
				},
				false,
			),
		)) as DispatchResult;
		expect(result?.hasMessage).toBe(false);
	});

	test("hasMessage=true when message is present", async () => {
		const result = (await dispatchVariable.run(
			makeTurn(
				{
					caller: "klaus",
					objective: "reply",
					mode: { kind: "async" },
				},
				true,
			),
		)) as DispatchResult;
		expect(result?.hasMessage).toBe(true);
	});
});
