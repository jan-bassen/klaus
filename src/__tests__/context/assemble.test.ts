import { describe, expect, test } from "bun:test";
import { assembleContext } from "@/core/assemble";
import { settings } from "@/settings";
import type { AgentDefinition, ContextVariable, TurnContext } from "@/types";

// Derive from config so tests don't break when budget changes
const BUDGET = settings.context.totalTokens;
const UNDER_HALF = Math.floor(BUDGET * 0.45); // two of these fit under budget
const OVER_HALF = Math.floor(BUDGET * 0.6); // two of these exceed budget

// ─── fixtures ────────────────────────────────────────────────────────────────

const CHAT_ID = "user@s.whatsapp.net";

const dummyAgent: AgentDefinition = {
	name: "test",
	modelTier: "default",
	tools: [],
	toolsets: [],
	providerTools: [],
	skills: [],
	persistent: false,
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
): ContextVariable {
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
		expect(result.messageRefs).toEqual({});
	});

	test("snippetsQuery → extraVars land as named template vars", async () => {
		const fakeSnippets: ContextVariable = {
			name: "snippets",
			priority: -1,
			run: async () => ({
				tokenCount: 0,
				truncate: "never" as const,
				vars: { soul: "I am a soul snippet", user: "user bio" },
			}),
		};
		const result = await assembleContext(makeTurn(), [fakeSnippets]);
		expect(result.vars.soul).toBeDefined();
		expect(typeof result.vars.soul).toBe("string");
		expect(result.totalTokens).toBe(0);
	});

	test("query result lands in vars keyed by query name", async () => {
		const q = makeQuery("memory", 2, "some memory content", 20, "always");
		const result = await assembleContext(makeTurn(), [q]);
		expect(result.vars.memory).toBe("some memory content");
	});

	test("all query results land in vars", async () => {
		const queries = [
			makeQuery("memory", 2, "some memory", 5, "always"),
			makeQuery("active_tasks", 4, "tasks", 5, "always"),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.vars.memory).toBe("some memory");
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
			makeQuery("memory", 2, "b", 700, "always"),
			makeQuery("active_tasks", 4, "c", 300, "always"),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.totalTokens).toBe(1000);
	});

	test("failed query is skipped, others continue", async () => {
		const bad: ContextVariable = {
			name: "broken",
			priority: 3,
			run: async () => {
				throw new Error("DB exploded");
			},
		};
		const good = makeQuery("memory", 2, "memory data", 5, "always");
		const result = await assembleContext(makeTurn(), [bad, good]);
		expect(result.vars.memory).toBe("memory data");
		expect(result.vars.broken).toBeUndefined(); // failed, not set
	});

	// ─── trimming: always ─────────────────────────────────────────────────────

	test("under budget → no trimming", async () => {
		const queries = [
			makeQuery("memory", 2, "memory content", UNDER_HALF, "always"),
			makeQuery("active_tasks", 4, "tasks", UNDER_HALF, "oldest"),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.vars.memory).toBe("memory content");
		expect(result.vars.active_tasks).toBe("tasks");
		expect(result.totalTokens).toBe(UNDER_HALF * 2);
	});

	test("over budget: always-truncate query is cleared (priority 2 trimmed before priority 3)", async () => {
		const queries = [
			makeQuery("memory", 2, "memory content", OVER_HALF, "always"),
			makeQuery("active_tasks", 3, "Turn 1\n\nTurn 2", OVER_HALF, "oldest"),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.vars.memory).toBe("");
		expect(result.vars.active_tasks).toBe("Turn 1\n\nTurn 2"); // untouched
		expect(result.totalTokens).toBe(OVER_HALF);
	});

	test("over budget: never-truncate is protected even with lowest priority number", async () => {
		const queries = [
			makeQuery("important", 1, "important convo", OVER_HALF, "never"),
			makeQuery("memory", 2, "less important memory", OVER_HALF, "always"),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.vars.important).toBe("important convo"); // protected
		expect(result.vars.memory).toBe(""); // cleared
	});

	// ─── trimming: oldest ────────────────────────────────────────────────────

	test("over budget: oldest-truncate removes blocks from front", async () => {
		// Excess = 3 tokens (just enough to remove the first block)
		const queries = [
			makeQuery(
				"active_tasks",
				3,
				"Block 1\n\nBlock 2\n\nBlock 3",
				BUDGET + 3,
				"oldest",
			),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.vars.active_tasks).not.toContain("Block 1");
		expect(result.vars.active_tasks).toContain("Block 2");
		expect(result.vars.active_tasks).toContain("Block 3");
	});

	test("over budget: oldest clears content if all blocks must be removed", async () => {
		const queries = [
			makeQuery("memory", 2, "important memory", OVER_HALF, "never"),
			makeQuery("active_tasks", 3, "Turn 1\n\nTurn 2", OVER_HALF, "oldest"),
		];
		const result = await assembleContext(makeTurn(), queries);
		expect(result.vars.active_tasks).toBe("");
	});

	// ─── totalTokens reflects post-trim state ────────────────────────────────

	test("totalTokens reflects post-trim state", async () => {
		const protectedTokens = Math.floor(BUDGET * 0.4);
		const queries = [
			makeQuery("memory", 2, "stuff", BUDGET - protectedTokens + 1, "always"),
			makeQuery("important", 3, "convo", protectedTokens, "never"),
		];
		// Pre-trim exceeds budget. memory (priority 2, always) cleared → only protectedTokens remain.
		const result = await assembleContext(makeTurn(), queries);
		expect(result.totalTokens).toBe(protectedTokens);
	});

	// ─── varParams ──────────────────────────────────────────────────────────

	test("varParams are passed to context variable run()", async () => {
		let receivedParams: Record<string, string> | undefined;
		const q: ContextVariable = {
			name: "tasks",
			priority: 2,
			run: async (_turn, params) => {
				receivedParams = params;
				return { content: "ok", tokenCount: 1, truncate: "always" };
			},
		};
		await assembleContext(makeTurn(), [q], { tasks: { limit: "3" } });
		expect(receivedParams).toEqual({ limit: "3" });
	});

	test("varParams are undefined when not provided for a variable", async () => {
		let receivedParams: Record<string, string> | undefined = { x: "y" };
		const q: ContextVariable = {
			name: "date",
			priority: -1,
			run: async (_turn, params) => {
				receivedParams = params;
				return { content: "Monday", tokenCount: 1, truncate: "never" };
			},
		};
		await assembleContext(makeTurn(), [q], { tasks: { limit: "3" } });
		expect(receivedParams).toBeUndefined();
	});

	// ─── userVars ────────────────────────────────────────────────────────────

	test("userVars are collected from context variable results", async () => {
		const q: ContextVariable = {
			name: "snippets",
			priority: -1,
			run: async () => ({
				tokenCount: 0,
				truncate: "never" as const,
				vars: { arch: "system content" },
				userVars: { greeting: "user content" },
			}),
		};
		const result = await assembleContext(makeTurn(), [q]);
		expect(result.vars.arch).toBe("system content");
		expect(result.userVars.greeting).toBe("user content");
	});

	test("userVars defaults to empty object when no variables provide it", async () => {
		const q = makeQuery("memory", 2, "data", 5, "always");
		const result = await assembleContext(makeTurn(), [q]);
		expect(result.userVars).toEqual({});
	});
});
