import path from "node:path";
import { settings } from "@/config";
import { log } from "@/logger";
import { resolveAgentDefaults } from "@/pipeline/overrides";
import type { TurnContext } from "@/types";
import { assembleVariables } from "@/variables";

// -- Dispatch types (owned by this domain) --

export type DispatchMode = { kind: "inline" } | { kind: "async" };

export interface DispatchOptions {
	agent: string;
	objective: string;
	hint?: string;
	mode: DispatchMode;
	chatId: string;
	caller?: string;
	/** Chain depth — incremented on each recursive dispatch. Enforces maxChainDepth. */
	depth?: number;
}

import { agentRegistry, loadAgentDefinition } from "./index";
import { type AgentRunPayload, enqueueJob, setWorker } from "./queue";
import { runAgent } from "./runner";

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
		log.warn(
			`[dispatch] max chain depth (${depth}) reached for @${agentName}, stopping`,
		);
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
		log.info(`[dispatch] inline to @${agentName} from ${caller}`);

		const replyCollector: string[] = [];
		const resolvedConfig = resolveAgentDefaults({}, def);
		const partialTurn: Omit<TurnContext, "vars"> = {
			chatId,
			agent: def,
			overrides: {},
			config: resolvedConfig,
			messageRefs: {},
			dispatchContext,
			_replyCollector: replyCollector,
		};

		const vars = await assembleVariables(partialTurn);
		const turn: TurnContext = { ...partialTurn, vars };

		await _runAgent(turn, def);
		return replyCollector.join("\n\n") || undefined;
	}

	// async mode: enqueue directly
	log.info(`[dispatch] async to @${agentName} from ${caller}`);

	enqueueJob({
		agentName,
		chatId,
		dispatchContext,
		depth: depth + 1,
	});

	return undefined;
}

// ─── Queue worker (merged from core/worker.ts) ──────────────────────────────

const AGENTS_DIR = settings.vault.agentsDir;

/**
 * Registers the queue worker for agent-run jobs.
 * Called once at startup after initQueue().
 */
export async function startWorkers(): Promise<void> {
	setWorker(async (job: AgentRunPayload) => {
		const { agentName, chatId, dispatchContext } = job;

		let def = agentRegistry.get(agentName);
		if (!def) {
			const promptPath = path.join(AGENTS_DIR, `${agentName}.md`);
			def = await loadAgentDefinition(promptPath);
			agentRegistry.set(def.name, def);
		}

		const resolvedConfig = resolveAgentDefaults({}, def);
		const partialTurn: Omit<TurnContext, "vars"> = {
			chatId,
			agent: def,
			overrides: {},
			config: resolvedConfig,
			messageRefs: {},
			dispatchContext,
		};

		try {
			const vars = await assembleVariables(partialTurn);
			const turn: TurnContext = { ...partialTurn, vars };

			log.info(`[dispatch] worker starting @${agentName}`);
			await runAgent(turn, def);
			log.info(`[dispatch] worker completed @${agentName}`);
		} catch (err) {
			log.error(`[dispatch] worker failed for @${agentName}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});
}
