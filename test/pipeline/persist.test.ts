/**
 * Dynamic-persistence agents: `executeAgent` must force a `persist` tool call
 * on a dedicated final step and create a timer from its args.
 *
 * Mock `@openrouter/sdk` so `new OpenRouter(...).chat.send` resolves twice:
 *   1. First call (main loop) — return a response with a normal reply tool call.
 *   2. Second call (forced persist) — return a response containing exactly
 *      one `persist` tool call with `{nextRun, prompt, overrides?}` JSON-encoded
 *      in `function.arguments`.
 *
 * Mock `addTimer` from `@/infra/store/timers` to observe the scheduled entry.
 */

import { afterEach, beforeEach, describe, it } from "vitest";

// import { executeAgent } from "@/pipeline/agent";

describe("pipeline/agent: dynamic persistence forced tool call", () => {
	beforeEach(() => {
		// vi.mock("@openrouter/sdk", ...)
		// vi.mock("@/infra/store/timers", ...)
	});

	afterEach(() => {
		// vi.restoreAllMocks()
	});

	it.todo("calls addTimer exactly once after the forced persist step resolves");

	it.todo("timer.agentName matches the persistent agent's name");

	it.todo("timer.objective equals the `prompt` arg from the persist call");

	it.todo("timer.runAt is within [now + minNextRun, now + maxNextRun]");

	it.todo("timer.overrides propagates from the persist call");

	it.todo(
		"throws if the persist step completes without calling the persist tool",
	);

	it.todo(
		"unparseable nextRun falls back to settings.persistence.defaultNextRun",
	);
});
