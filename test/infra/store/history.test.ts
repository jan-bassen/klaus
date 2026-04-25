/**
 * `infra/store/history.ts` — conversation JSONL round-trip.
 *
 * Use `initHistoryStore({dataDir: tmpDir})` per suite. The store writes to
 * `{dataDir}/conversations/YYYY-MM-DD.jsonl` — check the day-partitioned path
 * resolves via `settings.timezone`.
 */

import { afterEach, beforeEach, describe, it } from "vitest";

// import {
//   initHistoryStore, appendMessage, appendTrace, appendBreak, appendReaction,
//   getConversation, readAllMessages, getTraces, rebuildIndexes,
//   findByExternalId,
// } from "@/infra/store/history";
// import { makeTmpDir, rmTmpDir } from "../../helpers/tmp";

describe("infra/store/history: AppendMessageInput discriminated union", () => {
	it.todo(
		"assistant row requires agent + runId (ts-expect-error when missing)",
	);

	it.todo("user row refuses agent + runId (ts-expect-error when passed)");
});

describe("infra/store/history: round-trip", () => {
	let tmpDir: string;

	beforeEach(() => {
		// tmpDir = makeTmpDir();
		// initHistoryStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		// rmTmpDir(tmpDir);
	});

	it.todo(
		"appendMessage → getConversation returns the same row with generated id",
	);

	it.todo("assistant row round-trips agent + runId");

	it.todo("externalId is indexed — findByExternalId returns the messageId");

	it.todo("appendAck backfills externalId on the existing message");
});

describe("infra/store/history: break markers", () => {
	it.todo(
		"getConversation returns only rows appended after the most recent break",
	);

	it.todo(
		"readAllMessages ignores breaks (returns full history including pre-break)",
	);
});

describe("infra/store/history: reactions", () => {
	it.todo(
		"a reaction with empty emoji removes the existing reaction for that sender",
	);

	it.todo("re-reacting updates the emoji in place (no duplicate)");
});

describe("infra/store/history: traces", () => {
	it.todo("appendTrace → getTraces returns a Map keyed by runId");

	it.todo("trace persists trigger.kind and agent name");
});

describe("infra/store/history: rebuildIndexes", () => {
	it.todo(
		"after restart (new store instance, same dataDir) rebuildIndexes reconstructs externalId → messageId map",
	);

	it.todo(
		"lookbackDays caps the files scanned (older dated files are ignored)",
	);
});
