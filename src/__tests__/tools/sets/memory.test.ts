import { expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { describeDb, setupTestDb } from "@/__tests__/db/helpers";
import { db } from "@/db/client";
import { edges, nodes } from "@/db/schema";
import type { AgentDefinition, TurnContext } from "@/types";

/** Extract node ID from a memory.write result string — throws if not found. */
function extractNodeId(result: string): string {
	const id = result.match(/Created node (.+)/)?.[1];
	if (!id) throw new Error(`No node ID found in: ${result}`);
	return id;
}

// Stub the AI SDK to avoid calling Voyage AI in tests.
// writeNode → embedText → embed() from 'ai', so mocking at this level
// avoids replacing @/db/write (which breaks Bun's static export validation).
const MOCK_EMBEDDING = new Array(1024).fill(0.01);
mock.module("ai", () => ({
	embed: () => Promise.resolve({ embedding: MOCK_EMBEDDING }),
	generateText: mock(async () => ({
		text: "",
		steps: [{ usage: { inputTokens: 0, outputTokens: 0 } }],
	})),
}));
mock.module("voyage-ai-provider", () => ({
	voyage: Object.assign(() => ({}), { textEmbeddingModel: () => ({}) }),
}));

setupTestDb();

const dummyAgent: AgentDefinition = {
	name: "test",
	modelTier: "default",
	tools: [],
	promptPath: "/dev/null",
};

function makeContext(): TurnContext {
	return {
		chatId: "user@s.whatsapp.net",
		agent: dummyAgent,
		flags: {},
		assembled: { vars: {}, totalTokens: 0 },
	};
}

// Import tools directly — they use the real db from client.ts which points to the test DB
const {
	memoryWriteTool,
	memoryReadTool,
	memoryArchiveTool,
	memoryLinkTool,
	memoryUnlinkTool,
	memoryTraverseTool,
} = await import("@/tools/sets/memory");

describeDb("memory tools", () => {
	test("memory.write creates a node", async () => {
		const result = await memoryWriteTool.execute(
			{
				type: "topic",
				title: "Test Node",
				body: "Some content",
				tags: ["test"],
			},
			makeContext(),
		);
		expect(typeof result).toBe("string");
		expect(result as string).toMatch(/Created node/);

		// Verify in DB
		const allNodes = await db.select().from(nodes);
		expect(allNodes).toHaveLength(1);
		expect(allNodes[0]?.title).toBe("Test Node");
	});

	test("memory.read returns a written node", async () => {
		const writeResult = (await memoryWriteTool.execute(
			{ type: "topic", title: "Read Me", body: "Body text" },
			makeContext(),
		)) as string;
		const nodeId = extractNodeId(writeResult);

		const result = await memoryReadTool.execute({ id: nodeId }, makeContext());
		expect(result as string).toContain("Read Me");
		expect(result as string).toContain("Body text");
	});

	test("memory.read returns not found for missing ID", async () => {
		const result = await memoryReadTool.execute(
			{ id: "00000000-0000-0000-0000-000000000000" },
			makeContext(),
		);
		expect(result as string).toContain("not found");
	});

	test("memory.archive sets the archived flag", async () => {
		const writeResult = (await memoryWriteTool.execute(
			{ type: "topic", title: "Archive Me" },
			makeContext(),
		)) as string;
		const nodeId = extractNodeId(writeResult);

		await memoryArchiveTool.execute({ id: nodeId }, makeContext());

		const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
		expect(node?.archived).toBe(true);
	});

	test("memory.link creates an edge between two nodes", async () => {
		const r1 = (await memoryWriteTool.execute(
			{ type: "topic", title: "A" },
			makeContext(),
		)) as string;
		const r2 = (await memoryWriteTool.execute(
			{ type: "topic", title: "B" },
			makeContext(),
		)) as string;
		const idA = extractNodeId(r1);
		const idB = extractNodeId(r2);

		const result = await memoryLinkTool.execute(
			{ sourceId: idA, targetId: idB, relation: "related_to" },
			makeContext(),
		);
		expect(result as string).toContain("Linked");

		const allEdges = await db.select().from(edges);
		expect(allEdges).toHaveLength(1);
		expect(allEdges[0]?.sourceId).toBe(idA);
		expect(allEdges[0]?.targetId).toBe(idB);
	});

	test("memory.link is idempotent (no error on duplicate)", async () => {
		const r1 = (await memoryWriteTool.execute(
			{ type: "topic", title: "A" },
			makeContext(),
		)) as string;
		const r2 = (await memoryWriteTool.execute(
			{ type: "topic", title: "B" },
			makeContext(),
		)) as string;
		const idA = extractNodeId(r1);
		const idB = extractNodeId(r2);

		await memoryLinkTool.execute(
			{ sourceId: idA, targetId: idB, relation: "related_to" },
			makeContext(),
		);
		await memoryLinkTool.execute(
			{ sourceId: idA, targetId: idB, relation: "related_to" },
			makeContext(),
		);

		const allEdges = await db.select().from(edges);
		expect(allEdges).toHaveLength(1);
	});

	test("memory.unlink removes an edge", async () => {
		const r1 = (await memoryWriteTool.execute(
			{ type: "topic", title: "A" },
			makeContext(),
		)) as string;
		const r2 = (await memoryWriteTool.execute(
			{ type: "topic", title: "B" },
			makeContext(),
		)) as string;
		const idA = extractNodeId(r1);
		const idB = extractNodeId(r2);

		await memoryLinkTool.execute(
			{ sourceId: idA, targetId: idB, relation: "related_to" },
			makeContext(),
		);
		await memoryUnlinkTool.execute(
			{ sourceId: idA, targetId: idB, relation: "related_to" },
			makeContext(),
		);

		const allEdges = await db.select().from(edges);
		expect(allEdges).toHaveLength(0);
	});

	test("memory.traverse walks a graph A→B→C with depth 2", async () => {
		const rA = (await memoryWriteTool.execute(
			{ type: "topic", title: "A", body: "node A" },
			makeContext(),
		)) as string;
		const rB = (await memoryWriteTool.execute(
			{ type: "topic", title: "B", body: "node B" },
			makeContext(),
		)) as string;
		const rC = (await memoryWriteTool.execute(
			{ type: "topic", title: "C", body: "node C" },
			makeContext(),
		)) as string;
		const idA = extractNodeId(rA);
		const idB = extractNodeId(rB);
		const idC = extractNodeId(rC);

		await memoryLinkTool.execute(
			{ sourceId: idA, targetId: idB, relation: "related_to" },
			makeContext(),
		);
		await memoryLinkTool.execute(
			{ sourceId: idB, targetId: idC, relation: "related_to" },
			makeContext(),
		);

		const result = (await memoryTraverseTool.execute(
			{ startId: idA, depth: 2 },
			makeContext(),
		)) as string;

		expect(result).toContain("node A");
		expect(result).toContain("node B");
		expect(result).toContain("node C");
	});
});
