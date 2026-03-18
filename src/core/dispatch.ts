import path from "node:path";
import { log } from "@/logger";
import { settings } from "@/settings";
import { createTask, moveTask } from "@/store/tasks";
import type { DispatchOptions, TurnContext } from "@/types";
import { agentRegistry, loadAgentDefinition, runAgent } from "./agent";
import { assembleContext } from "./assemble";
import { enqueueJob, scheduleJob } from "./queue";

function agentsDir(): string {
	return path.join(settings.vault.dir, "Klaus", "agents");
}

// Test seam — allows dispatch.test.ts to override agent functions without mock.module.
let _runAgent = runAgent;
let _loadAgentDefinition = loadAgentDefinition;
/** @internal test-only */ export function _setDispatchSeamsForTest(seams: {
	runAgent?: typeof runAgent;
	loadAgentDefinition?: typeof loadAgentDefinition;
}): void {
	if (seams.runAgent) _runAgent = seams.runAgent;
	if (seams.loadAgentDefinition)
		_loadAgentDefinition = seams.loadAgentDefinition;
}
/** @internal test-only */ export function _clearDispatchSeamsForTest(): void {
	_runAgent = runAgent;
	_loadAgentDefinition = loadAgentDefinition;
}

/**
 * Unified dispatch primitive — the only way agents invoke other agents.
 *
 * Modes:
 *   inline — runs the agent synchronously in the current process; returns undefined (output via reply tool).
 *   async  — creates a task file and enqueues a job; returns the task ID.
 *   cron   — registers a schedule for the agent; returns undefined.
 */
export async function dispatch(
	opts: DispatchOptions,
): Promise<string | undefined> {
	const {
		agent: agentName,
		objective,
		hint,
		mode,
		chatId,
		caller = "system",
		parentTaskId,
		depth = 0,
	} = opts;

	if (mode.kind !== "cron" && depth >= settings.dispatch.maxChainDepth) {
		log.warn("[dispatch] max chain depth reached, stopping", {
			agentName,
			depth,
		});
		return undefined;
	}

	const dispatchContext: TurnContext["dispatchContext"] = {
		caller,
		objective,
		...(hint ? { hint } : {}),
		mode,
	};

	if (mode.kind === "cron") {
		log.info("[dispatch] scheduling cron job", {
			agentName,
			schedule: mode.schedule,
		});
		await scheduleJob(agentName, mode.schedule, {
			agentName,
			chatId,
			dispatchContext,
		});
		return undefined;
	}

	// For inline and async: load agent definition
	let def = agentRegistry.get(agentName);
	if (!def) {
		const promptPath = path.join(agentsDir(), `${agentName}.md`);
		def = await _loadAgentDefinition(promptPath);
		agentRegistry.set(def.name, def);
	}

	if (mode.kind === "inline") {
		log.info("[dispatch] inline dispatch", { agentName, caller, depth });

		const replyCollector: string[] = [];
		const partialTurn: Omit<TurnContext, "assembled"> = {
			chatId,
			agent: def,
			flags: {},
			dispatchContext,
			_replyCollector: replyCollector,
		};

		const assembled = await assembleContext(partialTurn);
		const turn: TurnContext = { ...partialTurn, assembled };

		await _runAgent(turn, def);
		return replyCollector.join("\n\n") || undefined;
	}

	// async mode: create task file + enqueue
	const taskId = await createTask({
		chatId,
		objective,
		assignedTo: agentName,
		caller,
		...(parentTaskId ? { parentTaskId } : {}),
	});

	log.info("[dispatch] async dispatch", {
		agentName,
		caller,
		taskId,
		depth,
	});

	await enqueueJob({
		taskId,
		agentName,
		chatId,
		dispatchContext,
		depth: depth + 1,
	});

	return taskId;
}

/** Update a task to 'running' status. */
export async function markTaskRunning(taskId: string): Promise<void> {
	await moveTask(taskId, "running");
}

/** Update a task to 'done' status. */
export async function markTaskDone(taskId: string): Promise<void> {
	await moveTask(taskId, "done", { completedAt: new Date().toISOString() });
}

/** Update a task to 'failed' status. */
export async function markTaskFailed(taskId: string): Promise<void> {
	await moveTask(taskId, "failed", { completedAt: new Date().toISOString() });
}
