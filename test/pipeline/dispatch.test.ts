import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../../src/infra/config.ts";
import { log } from "../../src/infra/logger.ts";
import {
	type AgentDefinition,
	AgentSchema,
	agentRegistry,
} from "../../src/pipeline/agents.ts";
import type { TurnContext } from "../../src/pipeline/core.ts";
import { executeAgent } from "../../src/pipeline/core.ts";
import { dispatch } from "../../src/pipeline/dispatch.ts";
import { overrideRegistry } from "../../src/pipeline/overrides.ts";
import {
	setVariables,
	type Variable,
} from "../../src/primitives/variables/index.ts";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.ts";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/pipeline/core.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/pipeline/core.ts")>();
	return {
		...actual,
		executeAgent: executeMock,
	};
});

describe("pipeline/dispatch.dispatch", () => {
	let tmpDir: string;
	let originalAgentsDir: string;
	let originalMaxChainDepth: number;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		originalAgentsDir = settings.vault.agentsDir;
		originalMaxChainDepth = settings.agent.maxChainDepth;

		settings.vault.agentsDir = path.join(tmpDir, "agents");
		mkdirSync(settings.vault.agentsDir, { recursive: true });
		settings.agent.maxChainDepth = 10;

		executeMock.mockImplementation(async ({ turn }) => {
			turn._replyCollector?.push("child reply");
		});
		agentRegistry.set("default", makeAgent("default"));
		agentRegistry.set("custom", makeAgent("custom", { tools: ["reply"] }));
		setVariables([testVariable]);
		overrideRegistry.set("simulate", {
			name: "simulate",
			description: "Dry run",
			overrides: { simulate: true },
		});
	});

	afterEach(() => {
		settings.vault.agentsDir = originalAgentsDir;
		settings.agent.maxChainDepth = originalMaxChainDepth;
		setVariables([]);
		executeMock.mockReset();
		rmTmpDir(tmpDir);
	});

	it("passes the resolved agent, prompt, chatId, trigger, and variables to executeAgent", async () => {
		const trigger = { kind: "schedule" as const, scheduleId: "schedule-1" };

		await dispatch({
			agent: "custom",
			prompt: "run the check",
			chatId: "chat-1",
			trigger,
		});

		expect(executeAgent).toHaveBeenCalledOnce();
		const call = executeMock.mock.calls[0]?.[0];
		expect(call?.def).toMatchObject({ name: "custom", tools: ["reply"] });
		expect(call?.variables).toEqual([testVariable]);
		expect(call?.turn).toMatchObject({
			chatId: "chat-1",
			agent: expect.objectContaining({ name: "custom" }),
			trigger,
			dispatchContext: { prompt: "run the check" },
			messageRefs: {},
			pendingSubReplies: [],
		});
		expect(call?.turn.runId).toEqual(expect.any(String));
	});

	it("uses the explicitly named agent without falling back to a default dispatch agent", async () => {
		await dispatch({
			agent: "custom",
			prompt: "objective",
			chatId: "chat-1",
			trigger: { kind: "timer", timerId: "timer-1" },
		});

		expect(executedTurn().agent.name).toBe("custom");
	});

	it("lazy-loads an agent from disk when it is missing from the registry", async () => {
		writeAgentFile(settings.vault.agentsDir, "lazy");

		await dispatch({
			agent: "lazy",
			prompt: "objective",
			chatId: "chat-1",
			trigger: { kind: "timer", timerId: "timer-1" },
		});

		expect(executedTurn().agent.name).toBe("lazy");
		expect(agentRegistry.get("lazy")?.name).toBe("lazy");
	});

	it("runs normally below the max chain depth", async () => {
		settings.agent.maxChainDepth = 2;

		await dispatch({
			agent: "custom",
			prompt: "objective",
			chatId: "chat-1",
			trigger: { kind: "dispatch", parentRunId: "parent-1" },
			depth: 1,
		});

		expect(executeAgent).toHaveBeenCalledOnce();
	});

	it("stops at the max chain depth and logs the guard trip", async () => {
		settings.agent.maxChainDepth = 2;
		const warnSpy = vi.spyOn(log, "warn");

		const result = await dispatch({
			agent: "custom",
			prompt: "objective",
			chatId: "chat-1",
			trigger: { kind: "dispatch", parentRunId: "parent-1" },
			depth: 2,
		});

		expect(result).toBeUndefined();
		expect(executeAgent).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith(
			"[dispatch] max chain depth (2) reached for @custom, stopping",
		);
	});

	it("wires an inline reply collector onto the child turn and returns joined replies", async () => {
		const collector: string[] = ["first"];
		executeMock.mockImplementationOnce(async ({ turn }) => {
			turn._replyCollector?.push("second", "third");
		});

		const result = await dispatch({
			agent: "custom",
			prompt: "objective",
			chatId: "chat-1",
			trigger: { kind: "dispatch", parentRunId: "parent-1" },
			replyCollector: collector,
		});

		expect(executedTurn()._replyCollector).toBe(collector);
		expect(result).toBe("first\n\nsecond\n\nthird");
	});

	it("omits the reply collector for top-level dispatches and returns undefined", async () => {
		executeMock.mockResolvedValueOnce(undefined);

		const result = await dispatch({
			agent: "custom",
			prompt: "objective",
			chatId: "chat-1",
			trigger: { kind: "schedule", scheduleId: "schedule-1" },
		});

		expect(executedTurn()._replyCollector).toBeUndefined();
		expect(result).toBeUndefined();
	});

	it("feeds override names into buildTurnConfig", async () => {
		await dispatch({
			agent: "custom",
			prompt: "objective",
			chatId: "chat-1",
			trigger: { kind: "dispatch", parentRunId: "parent-1" },
			overrides: ["simulate"],
		});

		expect(executedTurn().config).toMatchObject({
			simulate: true,
			ghost: true,
			skipHistory: true,
		});
	});

	it("preserves schedule, timer, and dispatch triggers unchanged", async () => {
		const triggers = [
			{ kind: "schedule" as const, scheduleId: "schedule-1" },
			{ kind: "timer" as const, timerId: "timer-1" },
			{ kind: "dispatch" as const, parentRunId: "parent-1" },
		];

		for (const trigger of triggers) {
			await dispatch({
				agent: "custom",
				prompt: "objective",
				chatId: "chat-1",
				trigger,
			});
		}

		expect(executeMock.mock.calls.map((call) => call[0].turn.trigger)).toEqual(
			triggers,
		);
	});
});

const testVariable: Variable = {
	key: "test",
	run: async () => "value",
};

function makeAgent(
	name: string,
	patch: { tools?: string[] } = {},
): AgentDefinition {
	const parsed = AgentSchema.parse({
		name,
		tools: patch.tools ?? [],
		settings: { report: "none" },
	});
	return { ...parsed, promptPath: path.join("/tmp", `${name}.md`) };
}

function writeAgentFile(dir: string, name: string): void {
	writeFileSync(
		path.join(dir, `${name}.md`),
		`---\nname: ${name}\ntools: [reply]\nsettings:\n  report: none\n---\nYou are ${name}.`,
	);
}

function executedTurn(): Omit<TurnContext, "vars"> {
	const turn = executeMock.mock.calls.at(-1)?.[0]?.turn;
	if (!turn) throw new Error("executeAgent was not called");
	return turn;
}
