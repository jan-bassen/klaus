import { settings } from "../infra/config.ts";
import { log } from "../infra/logger.ts";
import { getVariables } from "../primitives/variables/index.ts";
import { getOrLoadAgent } from "./agents.ts";
import type { ScheduleContext, Trigger, TurnContext } from "./core.ts";
import { executeAgent } from "./core.ts";
import { buildTurnConfig } from "./overrides.ts";
import { registerActiveRun } from "./runs.ts";

interface DispatchOptions {
	agent: string;
	prompt?: string;
	overrides?: string[];
	chatId: string;
	/** What kicked off this dispatch — schedule, timer, message, or another agent. */
	trigger: Trigger;
	/** Chain depth — incremented on each recursive dispatch. Enforces maxChainDepth. */
	depth?: number;
	resultCollector?: string[];
	schedule?: ScheduleContext;
	signal?: AbortSignal;
}

export async function dispatch(
	opts: DispatchOptions,
): Promise<string | undefined> {
	const {
		agent: agentName,
		chatId,
		trigger,
		depth = 0,
		resultCollector,
	} = opts;

	if (depth >= settings.agent.maxChainDepth) {
		log.warn(
			`[dispatch] max chain depth (${depth}) reached for @${agentName}, stopping`,
		);
		return undefined;
	}

	log.info(`[dispatch] @${agentName} (trigger: ${trigger.kind})`);
	const def = await getOrLoadAgent(agentName);

	const activeOverrides: Record<string, boolean> = {};
	for (const name of opts.overrides ?? []) activeOverrides[name] = true;
	const config = buildTurnConfig(def, activeOverrides);
	const partialTurn: Omit<TurnContext, "vars"> = {
		chatId,
		agent: def,
		runId: crypto.randomUUID(),
		trigger,
		overrides: {},
		config,
		messageRefs: {},
		...(opts.prompt !== undefined
			? { dispatchContext: { prompt: opts.prompt } }
			: {}),
		...(opts.schedule ? { schedule: opts.schedule } : {}),
		...(resultCollector ? { _resultCollector: resultCollector } : {}),
	};

	const ac = new AbortController();
	const unregisterActiveRun = registerActiveRun(ac);
	const signal = opts.signal
		? AbortSignal.any([opts.signal, ac.signal])
		: ac.signal;
	try {
		await executeAgent({
			turn: partialTurn,
			def,
			variables: getVariables(),
			signal,
		});
	} finally {
		unregisterActiveRun();
	}

	return resultCollector && resultCollector.length > 0
		? resultCollector.join("\n\n")
		: undefined;
}
