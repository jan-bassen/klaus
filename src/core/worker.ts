import path from "node:path";
import { log } from "@/logger";
import { settings } from "@/settings";
import { agentRegistry, loadAgentDefinition, runAgent } from "./agent";
import { assembleContext } from "./assemble";
import type { AgentRunPayload } from "./queue";
import { setWorker } from "./queue";

const AGENTS_DIR = path.join(settings.vault.dir, "Klaus", "agents");

/**
 * Registers the queue worker for agent-run jobs.
 * Called once at startup after initQueue().
 */
export async function startWorkers(): Promise<void> {
	setWorker(async (job: AgentRunPayload) => {
		const { agentName, chatId, dispatchContext, depth } = job;

		let def = agentRegistry.get(agentName);
		if (!def) {
			const promptPath = path.join(AGENTS_DIR, `${agentName}.md`);
			def = await loadAgentDefinition(promptPath);
			agentRegistry.set(def.name, def);
		}

		const partialTurn = {
			chatId,
			agent: def,
			flags: {} as Record<string, boolean>,
			dispatchContext,
		};

		try {
			const assembled = await assembleContext(partialTurn);
			const turn = { ...partialTurn, assembled };

			log.info("[worker] starting agent", { agentName, depth });
			await runAgent(turn, def);
			log.info("[worker] agent completed", { agentName });
		} catch (err) {
			log.error("[worker] agent failed", {
				agentName,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});
}
