/**
 * `primitives/tools/conversation.ts` — conversationTool.execute with a real history store.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendMessage } from "../../../src/infra/store/history.ts";
import { conversationTool } from "../../../src/primitives/tools/conversation.ts";
import { initAllStores } from "../../helpers/stores.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";
import { makeTurn } from "../../helpers/turn.ts";

async function addMsg(
	role: "user" | "assistant",
	content: string,
	externalId?: string,
): Promise<string> {
	if (role === "assistant") {
		return appendMessage({
			role,
			content,
			...(externalId ? { externalId } : {}),
			agent: "coach",
			runId: crypto.randomUUID(),
		});
	}

	return appendMessage({
		role,
		content,
		...(externalId ? { externalId } : {}),
	});
}

describe("conversationTool: text search", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("returns formatted messages matching query", async () => {
		await addMsg("user", "I went for a run today");
		await addMsg("assistant", "Great job on the run!");
		await addMsg("user", "What should I eat for lunch?");

		const ctx = makeTurn();
		const result = await conversationTool.execute({ query: "run" }, ctx);

		expect(result).toMatchObject({
			count: 2,
			messages: expect.stringContaining("run"),
		});
	});

	it("returns empty result when query matches nothing", async () => {
		await addMsg("user", "Hello there");

		const ctx = makeTurn();
		const result = await conversationTool.execute(
			{ query: "nonexistent term xyz" },
			ctx,
		);

		expect(result).toMatchObject({
			results: [],
			message: "No messages found.",
		});
	});

	it("respects the limit parameter", async () => {
		for (let i = 0; i < 5; i++) {
			await addMsg("user", `message ${i}`);
		}

		const ctx = makeTurn();
		const result = await conversationTool.execute({ limit: 2 }, ctx);

		expect(result).toMatchObject({ count: 2 });
	});
});

describe("conversationTool: around_message_id", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("returns messages surrounding the target externalId", async () => {
		await addMsg("user", "before-1");
		await addMsg("user", "target message", "ext-target");
		await addMsg("user", "after-1");

		const ctx = makeTurn();
		const result = await conversationTool.execute(
			{ around_message_id: "ext-target", context_window: 1 },
			ctx,
		);

		expect(result).toMatchObject({ count: 3 });
	});

	it("returns empty when externalId is not found", async () => {
		await addMsg("user", "some message");

		const ctx = makeTurn();
		const result = await conversationTool.execute(
			{ around_message_id: "no-such-ext-id" },
			ctx,
		);

		expect(result).toMatchObject({
			results: [],
			message: "No messages found.",
		});
	});
});

describe("conversationTool: time filters", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("after filter excludes messages before the timestamp", async () => {
		await addMsg("user", "old message");

		const futureTimestamp = new Date(Date.now() + 1_000_000).toISOString();
		const ctx = makeTurn();
		const result = await conversationTool.execute(
			{ after: futureTimestamp },
			ctx,
		);

		expect(result).toMatchObject({
			results: [],
			message: "No messages found.",
		});
	});

	it("before filter excludes messages after the timestamp", async () => {
		await addMsg("user", "recent message");

		const pastTimestamp = new Date(Date.now() - 1_000_000).toISOString();
		const ctx = makeTurn();
		const result = await conversationTool.execute(
			{ before: pastTimestamp },
			ctx,
		);

		expect(result).toMatchObject({
			results: [],
			message: "No messages found.",
		});
	});
});

describe("conversationTool: message formatting", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("uses agent name as role label for assistant messages", async () => {
		await addMsg("user", "ask");
		await addMsg("assistant", "reply");

		const ctx = makeTurn({ agent: { ...makeTurn().agent, name: "fitness" } });
		const result = await conversationTool.execute({}, ctx);

		expect(result).toMatchObject({ count: 2 });
		if (result && typeof result === "object" && "messages" in result) {
			expect(result.messages as string).toContain("fitness");
		}
	});
});
