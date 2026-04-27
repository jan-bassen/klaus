/**
 * `pipeline/confirmations.ts` — `evaluateGate` decision matrix.
 *
 * Pure logic over the (tool, turn) pair: no I/O. The gate decides skip vs
 * intercept based on simulation, autoAccept, trigger kind, and the
 * reaction-resume bypass slot. The actual `requestConfirmation` (which
 * persists + sends a WhatsApp message) is exercised by the resume tests
 * elsewhere.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Trigger, TurnContext } from "@/pipeline/agent";
import { evaluateGate } from "@/pipeline/confirmations";
import type { ConfirmationRequest, ToolDefinition } from "@/primitives/tools";
import { makeTurn } from "../helpers/turn";

const inputSchema = z.object({});

function gatedTool(
	verdict: ConfirmationRequest | false = { verb: "do", summary: "thing" },
): ToolDefinition<typeof inputSchema> {
	return {
		name: "test_tool",
		description: "test",
		inputSchema,
		execute: async () => "ok",
		requiresConfirmation: () => verdict,
		sideEffect: "stateful",
		kind: "builtin",
		capability: "tool",
	};
}

function unGatedTool(): ToolDefinition<typeof inputSchema> {
	return {
		name: "test_tool",
		description: "test",
		inputSchema,
		execute: async () => "ok",
		sideEffect: "stateful",
		kind: "builtin",
		capability: "tool",
	};
}

function turnWith(patch: Partial<TurnContext> = {}): TurnContext {
	return makeTurn(patch);
}

describe("pipeline/confirmations: evaluateGate", () => {
	it("skips when tool has no requiresConfirmation", () => {
		const decision = evaluateGate(unGatedTool(), {}, turnWith());
		expect(decision.kind).toBe("skip");
	});

	it("skips when simulate is on", () => {
		const decision = evaluateGate(
			gatedTool(),
			{},
			turnWith({ config: { simulate: true } }),
		);
		expect(decision.kind).toBe("skip");
	});

	it("skips when autoAccept is on", () => {
		const decision = evaluateGate(
			gatedTool(),
			{},
			turnWith({ config: { autoAccept: true } }),
		);
		expect(decision.kind).toBe("skip");
	});

	it("skips for schedule trigger (no user present)", () => {
		const decision = evaluateGate(
			gatedTool(),
			{},
			turnWith({ trigger: { kind: "schedule", scheduleId: "s1" } }),
		);
		expect(decision.kind).toBe("skip");
	});

	it("skips for timer trigger", () => {
		const decision = evaluateGate(
			gatedTool(),
			{},
			turnWith({ trigger: { kind: "timer", timerId: "t1" } }),
		);
		expect(decision.kind).toBe("skip");
	});

	it("skips for dispatch trigger", () => {
		const decision = evaluateGate(
			gatedTool(),
			{},
			turnWith({ trigger: { kind: "dispatch", parentRunId: "r1" } }),
		);
		expect(decision.kind).toBe("skip");
	});

	it("gates on a normal message trigger", () => {
		const decision = evaluateGate(gatedTool(), {}, turnWith());
		expect(decision).toEqual({
			kind: "gate",
			verb: "do",
			summary: "thing",
		});
	});

	it("respects the tool's per-call false verdict", () => {
		const decision = evaluateGate(gatedTool(false), {}, turnWith());
		expect(decision.kind).toBe("skip");
	});

	it("reaction-approve bypass clears the bypass slot exactly once", () => {
		const trigger: Trigger = {
			kind: "reaction",
			confirmationId: "c-1",
			decision: "approve",
		};
		const turn = turnWith({
			trigger,
			bypassConfirmationForTool: "test_tool",
		});
		const tool = gatedTool();

		const first = evaluateGate(tool, {}, turn);
		expect(first.kind).toBe("skip");
		expect(turn.bypassConfirmationForTool).toBeUndefined();

		// A second call to the same tool now re-gates — the bypass was one-shot.
		const second = evaluateGate(tool, {}, turn);
		expect(second.kind).toBe("gate");
	});

	it("reaction-deny does NOT bypass even with matching tool name", () => {
		const trigger: Trigger = {
			kind: "reaction",
			confirmationId: "c-1",
			decision: "deny",
		};
		const turn = turnWith({
			trigger,
			bypassConfirmationForTool: "test_tool",
		});
		const decision = evaluateGate(gatedTool(), {}, turn);
		expect(decision.kind).toBe("gate");
	});

	it("reaction-approve with a different tool name still gates the call", () => {
		const trigger: Trigger = {
			kind: "reaction",
			confirmationId: "c-1",
			decision: "approve",
		};
		const turn = turnWith({
			trigger,
			bypassConfirmationForTool: "other_tool",
		});
		const decision = evaluateGate(gatedTool(), {}, turn);
		expect(decision.kind).toBe("gate");
	});
});
