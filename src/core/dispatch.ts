import path from "node:path";
import { log } from "@/logger";
import { settings } from "@/settings";
import type { DispatchOptions, TurnContext } from "@/types";
import { agentRegistry, loadAgentDefinition, runAgent } from "./agent";
import { assembleContext } from "./assemble";
import { extractVarParams, readPromptBody } from "./interpolate";
import { enqueueJob } from "./queue";

function agentsDir(): string {
	return settings.vault.agentsDir;
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
 *   inline — runs the agent synchronously in the current process; returns collected reply text.
 *   async  — enqueues a background job; returns undefined.
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
		depth = 0,
	} = opts;

	if (depth >= settings.dispatch.maxChainDepth) {
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

	// Load agent definition
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
			overrides: {},
			dispatchContext,
			_replyCollector: replyCollector,
		};

		const promptBody = await readPromptBody(def.promptPath);
		const varParams = extractVarParams(promptBody, "hbs");
		const assembled = await assembleContext(
			partialTurn,
			undefined,
			Object.keys(varParams).length > 0 ? varParams : undefined,
		);
		const turn: TurnContext = { ...partialTurn, assembled };

		await _runAgent(turn, def);
		return replyCollector.join("\n\n") || undefined;
	}

	// async mode: enqueue directly
	log.info("[dispatch] async dispatch", { agentName, caller, depth });

	enqueueJob({
		agentName,
		chatId,
		dispatchContext,
		depth: depth + 1,
	});

	return undefined;
}
