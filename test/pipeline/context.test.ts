/**
 * `pipeline/context.ts`: variable assembly, history reconstruction, and the
 * `invokeTool` sim wrapper (accessible via `assembleTools(def, turn)` →
 * `allTools[name].execute(args)`).
 *
 * No model mocking needed — these exercise pre-model assembly only.
 *
 * Key edge cases:
 *   - `historyScope: "agent"` keeps user messages only when their NEXT
 *     assistant message matches the agent (tighter than role filter).
 *   - Traces replay by `row.runId`, not positional — validate with a row
 *     whose runId doesn't match the next-in-sequence trace.
 *   - invokeTool routes by `simulate` handler presence FIRST, then by
 *     sideEffect. Pure tools without handlers pass through under sim.
 */

import { afterEach, beforeEach, describe, it } from "vitest";

// import { assembleVariables, assembleTools, assembleHistory, invokeTool } from "@/pipeline/context";
// import { makeTurn } from "../helpers/turn";

describe("pipeline/context.assembleVariables", () => {
	it.todo(
		"runs first-phase variables in parallel, then after-phase with partial vars",
	);

	it.todo(
		"after-phase variables see partial `turn.vars` from first-phase results",
	);

	it.todo("a failing variable is logged but doesn't crash the phase");
});

describe("pipeline/context.assembleHistory", () => {
	it.todo("renders past assistant rows through message-agent.md template");

	it.todo(
		"historyScope: 'agent' keeps only user messages whose NEXT assistant is the target agent",
	);

	it.todo("historyLimit caps the window to the last N message pairs");

	it.todo("skipHistory yields an empty transcript");

	it.todo(
		"trace replay uses row.runId — not positional — to find the matching trace",
	);

	it.todo("showTrace: false suppresses the '[@X used Y → replied]' header");
});

describe("pipeline/context.invokeTool (sim wrapper)", () => {
	beforeEach(() => {
		// register a minimal pure, stateful, and external tool
	});
	afterEach(() => {
		/* registries cleared in setup.ts */
	});

	it.todo("no sim → passes through to tool.execute (real invocation)");

	it.todo("sim + pure tool without handler → passes through");

	it.todo(
		"sim + external tool without handler → fakeExternal result, overlay action logged",
	);

	it.todo(
		"sim + stateful tool without handler → fakeStateful result, overlay action logged",
	);

	it.todo(
		"sim + ANY tool with `simulate` handler → handler wins (regardless of sideEffect)",
	);
});
