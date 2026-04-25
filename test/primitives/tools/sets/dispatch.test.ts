/**
 * `primitives/tools/sets/dispatch.ts` — the unified `dispatch` tool + the
 * `.schedule` / `.list` / `.cancel` helpers.
 *
 * The `dispatch` tool is the headline change of Phase 8. Two shapes to cover:
 *   - `{prompt}` → inline run via `pipeline/dispatch.dispatch`
 *   - `{prompt, when}` → timer via `addTimer`
 *
 * Setup:
 *   - Mock `@/pipeline/dispatch` so `dispatchFn` is a spy returning a canned
 *     reply string. Assert on the options it received.
 *   - Mock `@/infra/store/timers` (`addTimer`) and `@/infra/store/schedules`
 *     (`addSchedule`, `getSchedules`, `removeSchedule`) to observe calls.
 *   - The tool reads `agentRegistry.keys()` inside its `description` getter —
 *     register a couple of agents so the dynamic list is non-empty if you
 *     assert on the string.
 */

import { afterEach, beforeEach, describe, it } from "vitest";

// import {
//   dispatchToolset,
//   parseRunAt,
// } from "@/primitives/tools/sets/dispatch";
// import { makeTurn } from "../../../helpers/turn";

describe("dispatch tool: inline path", () => {
	beforeEach(() => {
		// register agents; mock dispatchFn; mock addTimer
	});

	afterEach(() => {
		// vi.restoreAllMocks()
	});

	it.todo(
		"no `when`: calls dispatchFn with a slot pushed onto pendingSubReplies",
	);

	it.todo(
		"slot is the same array handed to dispatchFn as replyCollector (identity check)",
	);

	it.todo("agent defaults to 'dispatch' when omitted");

	it.todo("explicit agent name: passed through");

	it.todo("returns dispatchFn's joined string (or 'done' when it's empty)");

	it.todo("propagates overrides list to dispatchFn");

	it.todo("trigger === {kind:'dispatch', parentRunId: turn.runId}");
});

describe("dispatch tool: timer path (`when` set)", () => {
	it.todo("when === '2h': creates timer runAt ≈ now + 2h (via parseRunAt)");

	it.todo("when === ISO datetime: passes through as the exact runAt");

	it.todo(
		"addTimer called with agentName, chatId, objective === prompt, createdBy === context.agent.name",
	);

	it.todo("overrides propagate to timer.overrides when non-empty");

	it.todo("returns 'Timer set for @<agent> at <iso> [<id>]'");

	it.todo("invalid `when` string: parseRunAt throws");
});

describe("dispatch tool: simulate handler", () => {
	it.todo(
		"inline + sim: dispatchFn called with overrides prepended with 'simulate'",
	);

	it.todo("inline + sim: returns '(sim) done' when collector empty");

	it.todo("timer + sim: NO addTimer call; returns descriptive (sim) string");
});

describe("dispatch_schedule", () => {
	it.todo("execute: calls addSchedule with generated id + supplied fields");

	it.todo(
		"simulate: pushes onto overlay.pendingSchedules instead of addSchedule",
	);
});

describe("dispatch_list", () => {
	it.todo("execute: merges schedules + timers into a human-readable render");

	it.todo(
		"simulate: merges real + overlay entries, tags sim ones with ' (sim)'",
	);

	it.todo(
		"simulate: cancelled IDs are filtered out of both real and overlay lists",
	);
});

describe("dispatch_cancel", () => {
	it.todo(
		"execute: removes by ID from timers first, then schedules; reports which",
	);

	it.todo(
		"simulate + overlay-only id: splices from pendingTimers/pendingSchedules",
	);

	it.todo("simulate + real id: adds to overlay.cancelledIds (disk untouched)");

	it.todo("unknown id: returns 'No schedule or timer found with ID …'");
});

describe("parseRunAt", () => {
	it.todo("'30m' → now + 30*60*1000 (±tolerance)");

	it.todo("'2h' → now + 2*3600*1000");

	it.todo("'1d' → now + 86_400_000");

	it.todo("ISO datetime string → same date, toISOString()");

	it.todo("garbage input → throws with message mentioning valid forms");
});
