import { describe, expect, test } from "bun:test";
import { dispatchContextQuery } from "@/context/dispatch";
import type { AgentDefinition, TurnContext } from "@/types";

const dummyAgent: AgentDefinition = {
	name: "test",
	modelTier: "default",
	tools: [],
	promptPath: "/dev/null",
};

function makeTurn(
	dispatchContext?: TurnContext["dispatchContext"],
): TurnContext {
	const base: TurnContext = {
		chatId: "user@s.whatsapp.net",
		agent: dummyAgent,
		flags: {},
		assembled: { vars: {}, messageRefs: {}, totalTokens: 0 },
	};
	if (dispatchContext) base.dispatchContext = dispatchContext;
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
				caller: "klaus",
				objective: "Scheduled: morning check",
				hint: "Check weather and send summary",
				mode: { kind: "cron", schedule: "0 8 * * *" },
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

	test("appends scheduled-invocation note for cron mode", async () => {
		const result = await dispatchContextQuery.run(
			makeTurn({
				caller: "scheduler",
				objective: "Scheduled: daily report",
				mode: { kind: "cron", schedule: "0 3 * * *" },
			}),
		);
		expect(result.content).toContain("scheduled invocation");
		expect(result.content).toContain("`react`");
		expect(result.content).toContain("`reply`");
		expect(result.content).toContain("`send`");
	});

	test("does not append scheduled-invocation note for non-cron modes", async () => {
		for (const kind of ["inline", "async"] as const) {
			const result = await dispatchContextQuery.run(
				makeTurn({
					caller: "klaus",
					objective: "Do stuff",
					mode: { kind },
				}),
			);
			expect(result.content).not.toContain("scheduled invocation");
		}
	});
});
