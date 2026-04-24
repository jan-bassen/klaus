/**
 * End-to-end happy path through `handleTurn`.
 *
 * Setup strategy:
 *   - Mock `@/infra/whatsapp/send` so `enqueueMessage` becomes a spy.
 *   - Mock `generateText` from `ai` to return canned `AgentRunResult`-shaped
 *     steps with a single `reply` tool call.
 *   - `initAllStores(tmpDir)` in beforeEach; point `settings.basics.allowedChatId`
 *     at a known chatId (mutate the live `settings` object from `@/infra/config`
 *     directly in beforeEach, or use `vi.resetModules` + dynamic import).
 *   - Register the `reply` tool and a minimal agent manually (bypass glob load).
 *
 * Universal gotcha: `@/infra/logger` eagerly reads settings — `test/setup.ts`
 * preloads `@/infra/config` to avoid the crash. Don't reorder.
 */

import { afterEach, beforeEach, describe, it } from "vitest";

// Suggested imports when the next agent fills these in:
// import { vi } from "vitest";
// import { handleTurn } from "@/pipeline/index";
// import { makeTmpDir, rmTmpDir } from "../helpers/tmp";
// import { initAllStores } from "../helpers/stores";

describe("pipeline/index.handleTurn", () => {
	let tmpDir: string;

	beforeEach(() => {
		// tmpDir = makeTmpDir();
		// initAllStores(tmpDir);
		// register minimal `reply` tool + agent, seed allowedChatId.
	});

	afterEach(() => {
		// rmTmpDir(tmpDir);
		// clear mocks
	});

	it.todo(
		"routes a text message to the agent and enqueues the assistant reply",
	);

	it.todo(
		"persists both user and assistant rows to the conversation JSONL (assistant carries agent + runId)",
	);

	it.todo(
		"persists a trace row with matching runId + trigger.kind === 'message'",
	);

	it.todo(
		"writes a report entry to {dataDir}/logs/*.jsonl at the default level ('agent')",
	);

	it.todo(
		"rejects messages from non-allowlisted chatIds (no enqueue, warn logged)",
	);

	it.todo(
		"enters setup mode when allowedChatId is unset (replies with setup instructions)",
	);

	it.todo(
		"dispatches /commands without invoking the model (command.execute is called)",
	);

	it.todo(
		"parses !overrides from text (!large → turn.config.modelTier === 'large')",
	);

	it.todo(
		"routes to @agent prefix when present (overrides the per-chat default)",
	);

	it.todo(
		"resolves quoted media: reply to a message with an image carries the image through",
	);

	it.todo(
		"on unhandled error: enqueues the formatted error message + applies ❌ reaction",
	);
});
