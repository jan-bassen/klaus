/**
 * `pipeline/agent.ts`: `runAgent`, `executeAgent`, `flushPendingSubReplies`,
 * dynamic persistence forced tool call.
 *
 * Mocking: `vi.mock("ai", ...)` to control `generateText` return values.
 * Keep `stepCountIs` + `tool` passthrough (or mock minimally).
 *
 * Shape to mock for a single-step run:
 *   { text, usage: {inputTokens, outputTokens}, steps: [{
 *       reasoningText, toolCalls, toolResults, finishReason, usage
 *   }] }
 *
 * For flushPendingSubReplies tests: call directly after populating
 * `turn.pendingSubReplies` — no model call needed.
 */

import { afterEach, beforeEach, describe, it } from "vitest";

// import { executeAgent, runAgent, LlmTimeoutError } from "@/pipeline/agent";
// import { makeTurn } from "../helpers/turn";

describe("pipeline/agent.runAgent", () => {
	beforeEach(() => {
		// vi.mock("ai", ...)  — canned generateText
	});

	afterEach(() => {
		// vi.restoreAllMocks()
	});

	it.todo(
		"returns AgentRunResult with populated historyMessages, systemPrompt, userMessage, steps",
	);

	it.todo(
		"replyContent is the joined content of all `reply` tool calls (ignores other tools)",
	);

	it.todo(
		"throws LlmTimeoutError when generateText hangs past `settings.agent.timeout`",
	);

	it.todo(
		"retries retryable errors up to `settings.agent.retries.max` with exponential backoff",
	);

	it.todo(
		"does NOT retry on timeout, rate_limit, or 'prompt is too long' errors",
	);
});

describe("pipeline/agent.executeAgent", () => {
	it.todo(
		"emits a report at `turn.config.report` level on successful run",
	);

	it.todo(
		"emits an error report when runAgent throws (outcome.kind === 'error')",
	);

	it.todo(
		"skips trace persistence when turn.config.ghost is true",
	);

	it.todo(
		"skips trace persistence under !simulate (ghost elevated)",
	);
});

describe("pipeline/agent.flushPendingSubReplies", () => {
	it.todo(
		"top-level turn: enqueues each slot entry via enqueueMessage in slot order",
	);

	it.todo(
		"sub turn (_replyCollector set): bubbles slot entries into the parent collector",
	);

	it.todo(
		"top-level + simulate: skips enqueue entirely (overlay already logged the intent)",
	);

	it.todo(
		"preserves dispatch-call order when slots are filled out-of-order (B fills before A)",
	);

	it.todo(
		"clears pendingSubReplies after flush",
	);
});

describe("pipeline/agent: dynamic persistence", () => {
	it.todo(
		"after the main loop, forces a `persist` tool call and creates a timer via addTimer",
	);

	it.todo(
		"timer runAt falls inside [now + minNextRun, now + maxNextRun]",
	);

	it.todo(
		"propagates `overrides` from the persist tool call to the scheduled timer entry",
	);

	it.todo(
		"throws if the model fails to call `persist` on the forced step (no silent fallback)",
	);
});

describe("pipeline/agent.computeNextRun", () => {
	it.todo(
		"accepts ISO datetime strings",
	);

	it.todo(
		"accepts duration strings: '6h', '30m', '2d', '90s'",
	);

	it.todo(
		"clamps out-of-bounds values into [minNextRun, maxNextRun]",
	);

	it.todo(
		"falls back to settings.persistence.defaultNextRun on unparseable input",
	);
});
