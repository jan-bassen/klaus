import { settings } from "@/config";
import { log } from "@/logger";
import type { TurnContext } from "@/types";
import { agentRegistry, getOrLoadAgent } from "./definitions";
import { type AgentRunPayload, enqueueJob, setWorker } from "./queue";
import { runAgent } from "./runner";
import { buildTurn } from "./turn";

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

async function resolveAgent(name: string) {
	// Registry-first lookup lets tests observe that cached agents skip the loader.
	const cached = agentRegistry.get(name);
	if (cached) return cached;
	return getOrLoadAgent(name);
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

	if (mode.kind === "inline") {
		log.info(`[dispatch] inline to @${agentName} from ${caller}`);
		const def = await resolveAgent(agentName);
		const replyCollector: string[] = [];
		const turn = await buildTurn({
			chatId,
			def,
			dispatchContext,
			replyCollector,
		});
		await runAgent(turn, def);
		return replyCollector.join("\n\n") || undefined;
	}

	log.info(`[dispatch] async to @${agentName} from ${caller}`);
	enqueueJob({
		agentName,
		chatId,
		dispatchContext,
		depth: depth + 1,
	});
	return undefined;
}

/**
 * Registers the queue worker for agent-run jobs.
 * Called once at startup after initQueue().
 */
export async function startWorkers(): Promise<void> {
	setWorker(async (job: AgentRunPayload) => {
		const { agentName, chatId, dispatchContext } = job;

		try {
			const def = await getOrLoadAgent(agentName);
			const turn = await buildTurn({ chatId, def, dispatchContext });

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
