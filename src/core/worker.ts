import path from "node:path";
import { config } from "@/config";
import { log } from "@/logger";
import type { TurnContext } from "@/types";
import { agentRegistry, loadAgentDefinition, runAgent } from "./agent";
import { assembleContext } from "./assemble";
import { markTaskDone, markTaskFailed, markTaskRunning } from "./dispatch";
import type { AgentRunPayload } from "./queue";
import { setWorker } from "./queue";

const AGENTS_DIR = path.join(config.vault.dir, "Klaus", "agents");

/**
 * Registers the queue worker for agent-run jobs.
 * Called once at startup after initQueue().
 */
export async function startWorkers(): Promise<void> {
	setWorker(async (job: AgentRunPayload) => {
		const { agentName, taskId, chatId, dispatchContext, depth } = job;

		let def = agentRegistry.get(agentName);
		if (!def) {
			const promptPath = path.join(AGENTS_DIR, `${agentName}.md`);
			def = await loadAgentDefinition(promptPath);
			agentRegistry.set(def.name, def);
		}

		const partialTurn: Omit<TurnContext, "assembled"> = {
			chatId,
			taskId,
			agent: def,
			flags: {},
			dispatchContext,
		};

		await markTaskRunning(taskId);

		try {
			const assembled = await assembleContext(partialTurn);
			const turn: TurnContext = { ...partialTurn, assembled };

			log.info("[worker] starting agent", { agentName, taskId, depth });
			await runAgent(turn, def);
			await markTaskDone(taskId);
			log.info("[worker] agent completed", { agentName, taskId });
		} catch (err) {
			await markTaskFailed(taskId);
			log.error("[worker] agent failed", {
				agentName,
				taskId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// Note: cron re-dispatch is now handled by store/schedules.ts + queue.ts registerCronCallback.
}
