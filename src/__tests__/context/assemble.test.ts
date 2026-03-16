import { describe, expect, test } from "bun:test";
import { config } from "@/config";
import { flagsQuery } from "@/context/flags";
import { snippetsQuery } from "@/context/snippets";
import { assembleContext } from "@/core/assemble";
import type { AgentDefinition, ContextQuery, TurnContext } from "@/types";

// Derive from config so tests don't break when budget changes
const BUDGET = config.context.totalTokens;
const UNDER_HALF = Math.floor(BUDGET * 0.45); // two of these fit under budget
const OVER_HALF = Math.floor(BUDGET * 0.6); // two of these exceed budget

// ─── fixtures ────────────────────────────────────────────────────────────────

const CHAT_ID = "user@s.whatsapp.net";

const dummyAgent: AgentDefinition = {
	name: "test",
	modelTier: "default",
	tools: [],
	promptPath: "/dev/null",
};

function makeTurn(
	overrides: Partial<Omit<TurnContext, "assembled">> = {},
): Omit<TurnContext, "assembled"> {
	return {
		chatId: CHAT_ID,
		message: {
			kind: "whatsapp",
			id: "msg-1",
			chatId: CHAT_ID,
			senderId: CHAT_ID,
			text: "hello",
			timestamp: new Date(),
			messageKey: {},
		},
		agent: dummyAgent,
		flags: {},
		...overrides,
	};
}

function makeQuery(
	name: string,
	priority: number,
	content: string,
	tokenCount: number,
	truncate: "never" | "always" | "oldest" = "never",
): ContextQuery {
	return {
		name,
		priority,
		run: async () => ({ content, tokenCount, truncate }),
	};
}

describe("assembleContext", () => {
	// ─── basic shape ─────────────────────────────────────────────────────────

	test("no queries → vars is empty, totalTokens 0", async () => {
		const result = await assembleContext(makeTurn(), []);
		expect(result.vars).toEqual({});
		expect(result.totalTokens).toBe(0);
	});

	test("snippetsQuery → extraVars land as named template vars", async () => {
		const result = await assembleContext(makeTurn(), [snippetsQuery]);
		expect(result.vars.soul).toBeDefined();
		expect(typeof result.vars.soul).toBe("string");
		expect(result.totalTokens).toBe(0);
	});

	test("query result lands in vars keyed by query name", async () => {
		const q = makeQuery(
			"conversation",
			3,
			"User: hi\n\nKlaus: hello",
			20,
			"oldest",
		);
		const result = await assembleContext(makeTurn(), [q]);
		expect(result.vars.conversation).toBe("User: hi\n\nKlaus: hello");
	});

	test("all query results land in vars", async () => {
		const queries = [
			makeQuery("memory", 2, "some memory", 5, "always"),
			makeQuery("conversation", 3, "convo", 5, "oldest"),
			makeQuery("active_tasks", 4, "tasks", 5, "always"),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.vars.memory).toBe("some memory");
		expect(result.vars.conversation).toBe("convo");
		expect(result.vars.active_tasks).toBe("tasks");
	});

	test("arbitrary query names land in vars", async () => {
		const q = makeQuery("unknown_thing", 2, "whatever", 5, "always");
		const result = await assembleContext(makeTurn(), [q]);
		expect(result.totalTokens).toBe(5);
		expect(result.vars.unknown_thing).toBe("whatever");
	});

	test("sums tokenCount across all queries", async () => {
		const queries = [
			makeQuery("conversation", 3, "a", 300, "oldest"),
			makeQuery("memory", 2, "b", 700, "always"),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.totalTokens).toBe(1000);
	});

	test("failed query is skipped, others continue", async () => {
		const bad: ContextQuery = {
			name: "conversation",
			priority: 3,
			run: async () => {
				throw new Error("DB exploded");
			},
		};
		const good = makeQuery("memory", 2, "memory data", 5, "always");
		const result = await assembleContext(makeTurn(), [bad, good]);
		expect(result.vars.memory).toBe("memory data");
		expect(result.vars.conversation).toBeUndefined(); // failed, not set
	});

	// ─── flag injections ──────────────────────────────────────────────────────

	test("flags: { test: true } → flags gets test prompt string", async () => {
		const result = await assembleContext(makeTurn({ flags: { test: true } }), [
			flagsQuery,
		]);
		expect(result.vars.flags).toBe(
			"This is a test. If this is detected in the prompt, please mention it.",
		);
	});

	test("unknown flag → flags var is empty string", async () => {
		const result = await assembleContext(
			makeTurn({ flags: { unknown: true } }),
			[flagsQuery],
		);
		expect(result.vars.flags).toBe("");
	});

	test("flagsQuery tokenCount is 0", async () => {
		const result = await assembleContext(makeTurn({ flags: { test: true } }), [
			flagsQuery,
		]);
		expect(result.totalTokens).toBe(0);
	});

	// ─── contextParams forwarding ─────────────────────────────────────────────

	test("contextParams on agent are forwarded to query run()", async () => {
		let capturedParams: Record<string, unknown> | undefined;
		const spy: ContextQuery = {
			name: "conversation",
			priority: 3,
			run: async (_turn, params) => {
				capturedParams = params;
				return { content: "", tokenCount: 0, truncate: "never" as const };
			},
		};
		const agent: AgentDefinition = {
			...dummyAgent,
			contextParams: { conversation: { limit: 5 } },
		};
		await assembleContext(makeTurn({ agent }), [spy]);
		expect(capturedParams).toEqual({ limit: 5 });
	});

	test("query with no matching contextParams receives undefined", async () => {
		let capturedParams: Record<string, unknown> | undefined = {
			sentinel: true,
		};
		const spy: ContextQuery = {
			name: "memory",
			priority: 2,
			run: async (_turn, params) => {
				capturedParams = params;
				return { content: "", tokenCount: 0, truncate: "never" as const };
			},
		};
		// contextParams only defines 'conversation', not 'memory'
		const agent: AgentDefinition = {
			...dummyAgent,
			contextParams: { conversation: { limit: 5 } },
		};
		await assembleContext(makeTurn({ agent }), [spy]);
		expect(capturedParams).toBeUndefined();
	});

	// ─── trimming: always ─────────────────────────────────────────────────────

	test("under budget → no trimming", async () => {
		const queries = [
			makeQuery("memory", 2, "memory content", UNDER_HALF, "always"),
			makeQuery("conversation", 3, "convo", UNDER_HALF, "oldest"),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.vars.memory).toBe("memory content");
		expect(result.vars.conversation).toBe("convo");
		expect(result.totalTokens).toBe(UNDER_HALF * 2);
	});

	test("over budget: always-truncate query is cleared (priority 2 trimmed before priority 3)", async () => {
		const queries = [
			makeQuery("memory", 2, "memory content", OVER_HALF, "always"),
			makeQuery("conversation", 3, "Turn 1\n\nTurn 2", OVER_HALF, "oldest"),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.vars.memory).toBe("");
		expect(result.vars.conversation).toBe("Turn 1\n\nTurn 2"); // untouched
		expect(result.totalTokens).toBe(OVER_HALF);
	});

	test("over budget: never-truncate is protected even with lowest priority number", async () => {
		const queries = [
			makeQuery("conversation", 1, "important convo", OVER_HALF, "never"),
			makeQuery("memory", 2, "less important memory", OVER_HALF, "always"),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.vars.conversation).toBe("important convo"); // protected
		expect(result.vars.memory).toBe(""); // cleared
	});

	// ─── trimming: oldest ────────────────────────────────────────────────────

	test("over budget: oldest-truncate removes blocks from front", async () => {
		// Excess = 3 tokens (just enough to remove the first block)
		const queries = [
			makeQuery(
				"conversation",
				3,
				"Block 1\n\nBlock 2\n\nBlock 3",
				BUDGET + 3,
				"oldest",
			),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.vars.conversation).not.toContain("Block 1");
		expect(result.vars.conversation).toContain("Block 2");
		expect(result.vars.conversation).toContain("Block 3");
	});

	test("over budget: oldest clears content if all blocks must be removed", async () => {
		const queries = [
			makeQuery("memory", 2, "important memory", OVER_HALF, "never"),
			makeQuery("conversation", 3, "Turn 1\n\nTurn 2", OVER_HALF, "oldest"),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.vars.conversation).toBe("");
	});

	// ─── totalTokens reflects post-trim state ────────────────────────────────

	test("totalTokens reflects post-trim state", async () => {
		const protectedTokens = Math.floor(BUDGET * 0.4);
		const queries = [
			makeQuery("memory", 2, "stuff", BUDGET - protectedTokens + 1, "always"),
			makeQuery("conversation", 3, "convo", protectedTokens, "never"),
		];
		// Pre-trim exceeds budget. memory (priority 2, always) cleared → only protectedTokens remain.
		const result = await assembleContext(makeTurn(), queries);
		expect(result.totalTokens).toBe(protectedTokens);
	});
});
