import { expect, test } from "bun:test";
import { config } from "@/config";
import {
	conversationQuery,
	formatMessageTimestamp,
} from "@/context/conversation";
import { db } from "@/db/client";
import { messages } from "@/db/schema";
import type { AgentDefinition, InboundMessage } from "@/types";
import { describeDb, setupTestDb } from "./helpers";

setupTestDb();

const CHAT_ID = "user@s.whatsapp.net";
const OTHER_CHAT_ID = "other@s.whatsapp.net";

const dummyMsg: InboundMessage = {
	kind: "whatsapp",
	id: "msg-1",
	chatId: CHAT_ID,
	senderId: CHAT_ID,
	text: "hi",
	timestamp: new Date(),
	messageKey: {},
};

const dummyAgent: AgentDefinition = {
	name: "test",
	modelTier: "default",
	tools: [],
	promptPath: "/dev/null",
};

const turn = {
	chatId: CHAT_ID,
	message: dummyMsg,
	agent: dummyAgent,
	flags: {},
};

async function insertMessage(
	chatId: string,
	role: "user" | "assistant",
	content: string,
	opts?: { createdAt?: Date },
) {
	const [row] = await db
		.insert(messages)
		.values({
			chatId: chatId,
			role,
			content,
			createdAt: opts?.createdAt ?? new Date(),
		})
		.returning();
	if (!row) throw new Error("insert returned no row");
	return row;
}

describeDb("conversationQuery", () => {
	test("empty DB → empty content, zero tokens, truncate oldest", async () => {
		const result = await conversationQuery.run(turn);
		expect(result.content).toBe("");
		expect(result.tokenCount).toBe(0);
		expect(result.truncate).toBe("oldest");
	});

	test('single user message formatted as "[user | ts]\\n<content>"', async () => {
		const t0 = new Date("2024-01-01T10:00:00Z");
		await insertMessage(CHAT_ID, "user", "hello there", { createdAt: t0 });
		const result = await conversationQuery.run(turn);
		expect(result.content).toBe(
			`[#1 | user | ${formatMessageTimestamp(t0)}]\nhello there`,
		);
	});

	test('single assistant message formatted as "[<agent> | ts]\\n<content>"', async () => {
		const t0 = new Date("2024-01-01T10:00:00Z");
		await insertMessage(CHAT_ID, "assistant", "how can I help?", {
			createdAt: t0,
		});
		const result = await conversationQuery.run(turn);
		expect(result.content).toBe(
			`[#1 | ${dummyAgent.name} | ${formatMessageTimestamp(t0)}]\nhow can I help?`,
		);
	});

	test("user+assistant pair is in chronological order separated by double newline", async () => {
		const t0 = new Date("2024-01-01T10:00:00Z");
		const t1 = new Date("2024-01-01T10:01:00Z");
		await insertMessage(CHAT_ID, "user", "hi", { createdAt: t0 });
		await insertMessage(CHAT_ID, "assistant", "hello!", { createdAt: t1 });

		const result = await conversationQuery.run(turn);
		const blocks = result.content?.split("\n\n");
		expect(blocks).toHaveLength(2);
		expect(blocks?.[0]).toContain("user");
		expect(blocks?.[0]).toContain("hi");
		expect(blocks?.[1]).toContain(dummyAgent.name);
		expect(blocks?.[1]).toContain("hello!");
	});

	test("three messages appear in chronological order", async () => {
		const t0 = new Date("2024-01-01T10:00:00Z");
		const t1 = new Date("2024-01-01T10:01:00Z");
		const t2 = new Date("2024-01-01T10:02:00Z");
		await insertMessage(CHAT_ID, "user", "first", { createdAt: t0 });
		await insertMessage(CHAT_ID, "assistant", "second", { createdAt: t1 });
		await insertMessage(CHAT_ID, "user", "third", { createdAt: t2 });

		const result = await conversationQuery.run(turn);
		const blocks = result.content?.split("\n\n");
		expect(blocks).toHaveLength(3);
		expect(blocks?.[0]).toContain("first");
		expect(blocks?.[1]).toContain("second");
		expect(blocks?.[2]).toContain("third");
	});

	test("messages from other chatIds are excluded", async () => {
		const t0 = new Date("2024-01-01T10:00:00Z");
		await insertMessage(CHAT_ID, "user", "mine", { createdAt: t0 });
		await insertMessage(OTHER_CHAT_ID, "user", "not mine", { createdAt: t0 });

		const result = await conversationQuery.run(turn);
		expect(result.content).toContain("mine");
		expect(result.content).not.toContain("not mine");
	});

	test("messages with null content are skipped", async () => {
		const t0 = new Date("2024-01-01T10:00:00Z");
		const t1 = new Date("2024-01-01T10:01:00Z");
		// Insert a message with null content (tool-call-only assistant turn)
		await db.insert(messages).values({
			chatId: CHAT_ID,
			role: "assistant",
			content: null,
			createdAt: t0,
		});
		await insertMessage(CHAT_ID, "user", "visible", { createdAt: t1 });

		const result = await conversationQuery.run(turn);
		expect(result.content).toContain("visible");
		expect(result.content?.split("\n\n")).toHaveLength(1);
	});

	test("tokenCount uses char/4 estimate of content only (not header)", async () => {
		const content = "hello"; // 5 chars → Math.ceil(5/4) = 2 tokens
		const t0 = new Date("2024-01-01T10:00:00Z");
		await insertMessage(CHAT_ID, "user", content, { createdAt: t0 });
		const result = await conversationQuery.run(turn);
		expect(result.tokenCount).toBe(Math.ceil(content.length / 4));
	});

	test("token budget stops including oldest messages when exceeded", async () => {
		// Override budget to a small value so 3 short messages can exceed it.
		// Each message = 20 chars = 5 tokens. Budget = 8 → 1 fit, 2 don't? No:
		// We want 2 fit (10 tokens) but 3 don't (15 tokens) → budget between 10 and 14.
		const ctx = config.context as { conversationTokens: number };
		const originalBudget = ctx.conversationTokens;
		const charsPerMsg = 20;
		const tokensPerMsg = Math.ceil(charsPerMsg / 4); // 5
		ctx.conversationTokens = tokensPerMsg * 2; // 10 — exactly 2 fit
		try {
			const pad = (label: string) =>
				label + "x".repeat(charsPerMsg - label.length);
			const t0 = new Date("2024-01-01T10:00:00Z");
			const t1 = new Date("2024-01-01T10:01:00Z");
			const t2 = new Date("2024-01-01T10:02:00Z");
			await insertMessage(CHAT_ID, "user", pad("oldest"), { createdAt: t0 });
			await insertMessage(CHAT_ID, "assistant", pad("middle"), {
				createdAt: t1,
			});
			await insertMessage(CHAT_ID, "user", pad("newest"), { createdAt: t2 });

			const result = await conversationQuery.run(turn);
			expect(result.content).not.toContain("oldest");
			expect(result.content).toContain("middle");
			expect(result.content).toContain("newest");
			expect(result.tokenCount).toBe(2 * tokensPerMsg);
		} finally {
			ctx.conversationTokens = originalBudget;
		}
	});

	test("name and priority are correct", () => {
		expect(conversationQuery.name).toBe("conversation");
		expect(conversationQuery.priority).toBe(3);
	});

	test("limit param caps returned messages to N most recent", async () => {
		const t0 = new Date("2024-01-01T10:00:00Z");
		const t1 = new Date("2024-01-01T10:01:00Z");
		const t2 = new Date("2024-01-01T10:02:00Z");
		await insertMessage(CHAT_ID, "user", "first", { createdAt: t0 });
		await insertMessage(CHAT_ID, "assistant", "second", { createdAt: t1 });
		await insertMessage(CHAT_ID, "user", "third", { createdAt: t2 });

		const result = await conversationQuery.run(turn, { limit: 1 });
		expect(result.content?.split("\n\n")).toHaveLength(1);
		expect(result.content).toContain("third");
		expect(result.content).not.toContain("first");
		expect(result.content).not.toContain("second");
	});

	test("limit: 2 returns the two most recent messages in chronological order", async () => {
		const t0 = new Date("2024-01-01T10:00:00Z");
		const t1 = new Date("2024-01-01T10:01:00Z");
		const t2 = new Date("2024-01-01T10:02:00Z");
		await insertMessage(CHAT_ID, "user", "first", { createdAt: t0 });
		await insertMessage(CHAT_ID, "assistant", "second", { createdAt: t1 });
		await insertMessage(CHAT_ID, "user", "third", { createdAt: t2 });

		const result = await conversationQuery.run(turn, { limit: 2 });
		const blocks = result.content?.split("\n\n");
		expect(blocks).toHaveLength(2);
		expect(blocks?.[0]).toContain("second");
		expect(blocks?.[1]).toContain("third");
		expect(result.content).not.toContain("first");
	});
});
