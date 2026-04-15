import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let savedDataDir: string | undefined;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "conv-test-"));
	savedDataDir = process.env.DATA_DIR;
	process.env.DATA_DIR = tmpDir;
});

afterAll(async () => {
	if (savedDataDir !== undefined) process.env.DATA_DIR = savedDataDir;
	else delete process.env.DATA_DIR;
	await rm(tmpDir, { recursive: true, force: true });
});

const {
	appendMessage,
	appendAck,
	appendReaction,
	appendBreak,
	appendSupersede,
	getConversation,
	findByExternalId,
	resolveExternalId,
	resolveMessageId,
	rebuildIndexes,
	readAllMessages,
	searchConversation,
	_clearIndexesForTest,
} = await import("@/store/conversation");

beforeEach(() => {
	_clearIndexesForTest();
});

afterEach(async () => {
	// Clean all conversation files between tests
	const { readdir: readdirAsync, rm: rmAsync } = await import(
		"node:fs/promises"
	);
	try {
		const convDir = join(tmpDir, "conversations");
		const files = await readdirAsync(convDir);
		for (const f of files) {
			if (f.endsWith(".jsonl")) {
				await rmAsync(join(convDir, f));
			}
		}
	} catch {
		// doesn't exist
	}
});

describe("appendMessage", () => {
	test("returns a UUID and message is retrievable", async () => {
		const id = await appendMessage({
			role: "user",
			content: "hello",
			externalId: "wa-1",
		});
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);

		const conv = await getConversation();
		expect(conv).toHaveLength(1);
		expect(conv[0]?.content).toBe("hello");
		expect(conv[0]?.role).toBe("user");
	});

	test("preserves overrides and command fields", async () => {
		await appendMessage({
			role: "user",
			content: "/status",
			command: "status",
			overrides: ["verbose"],
		});

		const conv = await getConversation();
		expect(conv[0]?.command).toBe("status");
		expect(conv[0]?.overrides).toEqual(["verbose"]);
	});
});

describe("appendAck", () => {
	test("backfills externalId on existing message", async () => {
		const id = await appendMessage({
			role: "assistant",
			content: "reply",
		});
		await appendAck(id, "wa-reply-1");

		const conv = await getConversation();
		expect(conv[0]?.externalId).toBe("wa-reply-1");
	});

	test("updates in-memory indexes", async () => {
		const id = await appendMessage({
			role: "assistant",
			content: "reply",
		});
		await appendAck(id, "wa-reply-2");

		expect(resolveMessageId(id)).toBe("wa-reply-2");
		expect(resolveExternalId("wa-reply-2")).toBe(id);
	});
});

describe("appendReaction", () => {
	test("attaches reaction to message", async () => {
		await appendMessage({
			role: "user",
			content: "funny",
			externalId: "wa-msg-1",
		});
		await appendReaction({
			messageExternalId: "wa-msg-1",
			emoji: "😂",
			senderId: "user@s.whatsapp.net",
			fromMe: false,
		});

		const conv = await getConversation();
		expect(conv[0]?.reactions).toHaveLength(1);
		expect(conv[0]?.reactions[0]?.emoji).toBe("😂");
	});

	test("empty emoji removes the reaction", async () => {
		await appendMessage({
			role: "user",
			content: "test",
			externalId: "wa-msg-2",
		});
		await appendReaction({
			messageExternalId: "wa-msg-2",
			emoji: "👍",
			senderId: "user1",
			fromMe: false,
		});
		await appendReaction({
			messageExternalId: "wa-msg-2",
			emoji: "",
			senderId: "user1",
			fromMe: false,
		});

		const conv = await getConversation();
		expect(conv[0]?.reactions).toHaveLength(0);
	});
});

describe("findByExternalId", () => {
	test("returns messageId for known externalId", async () => {
		const id = await appendMessage({
			role: "user",
			content: "test",
			externalId: "wa-find-1",
		});
		const found = findByExternalId("wa-find-1");
		expect(found?.messageId).toBe(id);
	});

	test("returns null for unknown externalId", () => {
		expect(findByExternalId("unknown")).toBeNull();
	});
});

describe("appendBreak", () => {
	test("messages before break are excluded from getConversation", async () => {
		await appendMessage({ role: "user", content: "before", externalId: "e1" });
		await appendBreak();
		await appendMessage({ role: "user", content: "after", externalId: "e2" });

		const conv = await getConversation();
		expect(conv).toHaveLength(1);
		expect(conv[0]?.content).toBe("after");
	});

	test("multiple breaks — only last one matters", async () => {
		await appendMessage({ role: "user", content: "msg1" });
		await appendBreak();
		await appendMessage({ role: "user", content: "msg2" });
		await appendBreak();
		await appendMessage({ role: "user", content: "msg3" });

		const conv = await getConversation();
		expect(conv).toHaveLength(1);
		expect(conv[0]?.content).toBe("msg3");
	});

	test("break on empty day returns empty conversation", async () => {
		await appendBreak();

		const conv = await getConversation();
		expect(conv).toHaveLength(0);
	});

	test("break does not clear in-memory indexes", async () => {
		await appendMessage({
			role: "user",
			content: "test",
			externalId: "wa-brk-1",
		});
		await appendBreak();

		// Index should still have the message for quote/reaction resolution
		const found = findByExternalId("wa-brk-1");
		expect(found).not.toBeNull();
	});
});

describe("appendSupersede", () => {
	test("superseded message is excluded from getConversation", async () => {
		const keep = await appendMessage({
			role: "user",
			content: "keep me",
			externalId: "wa-sup-1",
		});
		const hide = await appendMessage({
			role: "assistant",
			content: "hide me",
			externalId: "wa-sup-2",
		});
		await appendSupersede(hide, "retry");

		const conv = await getConversation();
		expect(conv).toHaveLength(1);
		expect(conv[0]?.id).toBe(keep);
	});

	test("superseded message is also excluded from readAllMessages", async () => {
		await appendMessage({
			role: "user",
			content: "visible",
			externalId: "wa-sup-3",
		});
		const hideId = await appendMessage({
			role: "assistant",
			content: "hidden",
			externalId: "wa-sup-4",
		});
		await appendSupersede(hideId);

		const all = await readAllMessages();
		expect(all.map((m) => m.content)).toEqual(["visible"]);
	});

	test("supersede without a matching message is a no-op", async () => {
		await appendMessage({
			role: "user",
			content: "normal",
			externalId: "wa-sup-5",
		});
		await appendSupersede("unknown-id", "retry");

		const conv = await getConversation();
		expect(conv).toHaveLength(1);
	});
});

describe("rebuildIndexes", () => {
	test("restores in-memory indexes from file", async () => {
		const id = await appendMessage({
			role: "user",
			content: "persist",
			externalId: "wa-rebuild-1",
		});
		const ackId = await appendMessage({
			role: "assistant",
			content: "response",
		});
		await appendAck(ackId, "wa-ack-1");

		_clearIndexesForTest();
		expect(findByExternalId("wa-rebuild-1")).toBeNull();

		await rebuildIndexes();
		expect(findByExternalId("wa-rebuild-1")?.messageId).toBe(id);
		expect(resolveExternalId("wa-ack-1")).toBe(ackId);
	});
});

describe("searchConversation", () => {
	test("searches by query text, ignoring breaks", async () => {
		await appendMessage({
			role: "user",
			content: "I love pizza",
			externalId: "wa-s1",
		});
		await appendBreak();
		await appendMessage({
			role: "user",
			content: "Pizza is the best food",
			externalId: "wa-s3",
		});

		const results = await searchConversation({ query: "pizza" });
		expect(results).toHaveLength(2);
		expect(results[0]?.content).toBe("I love pizza");
		expect(results[1]?.content).toBe("Pizza is the best food");
	});

	test("around mode returns context window", async () => {
		for (let i = 0; i < 10; i++) {
			await appendMessage({
				role: i % 2 === 0 ? "user" : "assistant",
				content: `message ${i}`,
				externalId: `wa-around-${i}`,
			});
		}

		const results = await searchConversation({
			around: "wa-around-5",
			contextWindow: 2,
		});
		expect(results).toHaveLength(5); // 2 before + target + 2 after
		expect(results[2]?.content).toBe("message 5");
	});

	test("around mode returns empty for unknown externalId", async () => {
		await appendMessage({
			role: "user",
			content: "test",
			externalId: "wa-x",
		});
		const results = await searchConversation({ around: "wa-unknown" });
		expect(results).toHaveLength(0);
	});

	test("filters by before/after timestamps", async () => {
		await appendMessage({
			role: "user",
			content: "early message",
			externalId: "wa-t1",
		});
		// Delay to ensure distinct timestamps
		await new Promise((r) => setTimeout(r, 20));
		const cutoff = new Date().toISOString();
		await new Promise((r) => setTimeout(r, 20));
		await appendMessage({
			role: "user",
			content: "late message",
			externalId: "wa-t2",
		});

		const before = await searchConversation({ before: cutoff });
		expect(before).toHaveLength(1);
		expect(before[0]?.content).toBe("early message");

		const after = await searchConversation({ after: cutoff });
		expect(after).toHaveLength(1);
		expect(after[0]?.content).toBe("late message");
	});
});
