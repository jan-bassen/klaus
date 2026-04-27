/**
 * `pipeline/dispatch.ts` — the `dispatch()` primitive.
 *
 * Three call sites hit this:
 *   1. The `dispatch` tool (parent agent invokes inline)
 *   2. Cron firings (`src/index.ts` schedule handler)
 *   3. Timer firings (`src/index.ts` timer handler)
 *
 * Exercise the primitive directly with a partial `DispatchOptions`. Don't go
 * through the tool wrapper — that's covered in the tool-set test.
 *
 * Setup:
 *   - Mock `@/pipeline/core` so `executeAgent` is a spy (don't actually hit
 *     the model). Assert on the partial turn it received.
 *   - Register a minimal agent named "dispatch" (the default) in
 *     `agentRegistry` so `resolveAgent` finds it.
 *   - For chain-depth tests: mock `executeAgent` to synchronously call
 *     `dispatch()` again, incrementing depth until the guard trips.
 */

import { afterEach, beforeEach, describe, it } from "vitest";

// import { dispatch } from "@/pipeline/dispatch";

describe("pipeline/dispatch.dispatch: basic invocation", () => {
	beforeEach(() => {
		// register minimal "dispatch" + "custom" agents; spy on executeAgent
	});

	afterEach(() => {
		// vi.restoreAllMocks()
	});

	it.todo("passes agent, prompt, chatId, trigger through to executeAgent");

	it.todo(
		"defaults to the explicitly-named agent — no implicit 'dispatch' fallback at primitive layer (the tool layer sets the default)",
	);

	it.todo(
		"resolves agent from agentRegistry; lazy-loads from disk on miss via getOrLoadAgent",
	);
});

describe("pipeline/dispatch.dispatch: chain depth guard", () => {
	it.todo("depth below settings.agent.maxChainDepth: runs normally");

	it.todo(
		"depth === maxChainDepth: returns undefined without invoking executeAgent",
	);

	it.todo("warn logged when depth cap trips");
});

describe("pipeline/dispatch.dispatch: reply collector wiring", () => {
	it.todo(
		"replyCollector passed: turn._replyCollector is set — sub replies bubble",
	);

	it.todo(
		"replyCollector omitted: turn._replyCollector is undefined — replies fall through to WhatsApp",
	);

	it.todo("return value: joins collector entries with '\\n\\n' when populated");

	it.todo("return value: undefined when collector is absent OR empty");
});

describe("pipeline/dispatch.dispatch: overrides + config", () => {
	it.todo(
		"overrides list feeds buildTurnConfig (e.g. ['simulate'] yields config.simulate === true)",
	);

	it.todo(
		"dispatchContext.prompt === opts.prompt (available to the child's prompt template)",
	);

	it.todo("pendingSubReplies initialised as [] on the partial turn");
});

describe("pipeline/dispatch.dispatch: trigger propagation", () => {
	it.todo(
		"trigger.kind === 'schedule' from cron handler reaches executeAgent unchanged",
	);

	it.todo(
		"trigger.kind === 'timer' from timer handler reaches executeAgent unchanged",
	);

	it.todo(
		"trigger.kind === 'dispatch' with parentRunId from the dispatch tool reaches child",
	);
});
