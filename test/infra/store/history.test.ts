/**
 * `infra/store/history.ts` — conversation JSONL round-trip + indexing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendBreak,
	appendMessage,
	appendReaction,
	appendTrace,
	createConversationStore,
	findByExternalId,
	getConversation,
	getTraces,
	initHistoryStore,
	readAllMessages,
	rebuildIndexes,
} from "../../../src/infra/store/history.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

describe("infra/store/history: round-trip", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initHistoryStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("appendMessage → getConversation returns the row with generated id", async () => {
		const id = await appendMessage({ role: "user", content: "hi" });
		const conv = await getConversation();
		expect(conv).toHaveLength(1);
		expect(conv[0]?.id).toBe(id);
		expect(conv[0]?.role).toBe("user");
		expect(conv[0]?.content).toBe("hi");
	});

	it("assistant row round-trips agent + runId", async () => {
		await appendMessage({ role: "user", content: "q" });
		await appendMessage({
			role: "assistant",
			content: "a",
			agent: "fitness",
			runId: "r-1",
		});
		const conv = await getConversation();
		const assistant = conv.find((m) => m.role === "assistant");
		expect(assistant?.agent).toBe("fitness");
		expect(assistant?.runId).toBe("r-1");
	});

	it("findByExternalId resolves to the messageId", async () => {
		const id = await appendMessage({
			role: "user",
			content: "hi",
			externalId: "ext-1",
		});
		expect(findByExternalId("ext-1")).toEqual({ messageId: id });
		expect(findByExternalId("nope")).toBeNull();
	});
});

describe("infra/store/history: break markers", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initHistoryStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("getConversation returns only rows after the most recent break", async () => {
		await appendMessage({ role: "user", content: "old" });
		await appendBreak();
		await appendMessage({ role: "user", content: "new" });
		const conv = await getConversation();
		expect(conv.map((m) => m.content)).toEqual(["new"]);
	});

	it("readAllMessages ignores breaks (returns full history)", async () => {
		await appendMessage({ role: "user", content: "old" });
		await appendBreak();
		await appendMessage({ role: "user", content: "new" });
		const all = await readAllMessages();
		expect(all.map((m) => m.content)).toEqual(["old", "new"]);
	});
});

describe("infra/store/history: reactions", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initHistoryStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("re-reacting updates emoji in place; empty emoji removes", async () => {
		await appendMessage({
			role: "assistant",
			content: "hi",
			agent: "a",
			runId: "r",
			externalId: "ext-1",
		});

		await appendReaction({
			messageExternalId: "ext-1",
			emoji: "👍",
			senderId: "u",
			fromMe: true,
		});
		let conv = await getConversation();
		expect(conv[0]?.reactions).toEqual([
			expect.objectContaining({ emoji: "👍", senderId: "u", fromMe: true }),
		]);

		await appendReaction({
			messageExternalId: "ext-1",
			emoji: "❤️",
			senderId: "u",
			fromMe: true,
		});
		conv = await getConversation();
		expect(conv[0]?.reactions).toEqual([
			expect.objectContaining({ emoji: "❤️", senderId: "u", fromMe: true }),
		]);

		await appendReaction({
			messageExternalId: "ext-1",
			emoji: "",
			senderId: "u",
			fromMe: true,
		});
		conv = await getConversation();
		expect(conv[0]?.reactions).toEqual([]);
	});

	it("round-trips reaction attribution", async () => {
		await appendMessage({
			role: "user",
			content: "ok?",
			externalId: "ext-1",
		});

		await appendReaction({
			messageExternalId: "ext-1",
			emoji: "✅",
			senderId: "bot",
			fromMe: true,
			agent: "assistant",
			runId: "run-1",
		});

		const conv = await getConversation();
		expect(conv[0]?.reactions).toEqual([
			expect.objectContaining({
				emoji: "✅",
				senderId: "bot",
				fromMe: true,
				agent: "assistant",
				runId: "run-1",
				createdAt: expect.any(String),
			}),
		]);
	});
});

describe("infra/store/history: traces", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initHistoryStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("appendTrace → getTraces returns a Map keyed by runId", async () => {
		await appendTrace("r-1", "fitness", { kind: "message", messageId: "m-1" }, [
			{ toolCalls: [], toolResults: [] },
		]);
		const traces = await getTraces();
		expect(traces.size).toBe(1);
		const entry = traces.get("r-1");
		expect(entry?.agent).toBe("fitness");
		expect(entry?.trigger).toEqual({ kind: "message", messageId: "m-1" });
		expect(entry?.steps).toHaveLength(1);
	});
});

describe("infra/store/history: rebuildIndexes", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("rebuildIndexes reconstructs externalId → messageId after restart", async () => {
		const first = createConversationStore({ dataDir: tmpDir });
		const id = await first.appendMessage({
			role: "user",
			content: "hi",
			externalId: "ext-7",
		});

		// Fresh store (no in-memory index) pointing at the same dir.
		initHistoryStore({ dataDir: tmpDir });
		expect(findByExternalId("ext-7")).toBeNull();
		await rebuildIndexes();
		expect(findByExternalId("ext-7")).toEqual({ messageId: id });
	});
});
