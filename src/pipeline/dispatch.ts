/**
 * Dispatch primitive — the only way the framework kicks off an agent run.
 *
 * Three call sites:
 *   1. The `dispatch` tool (parent agent invokes a child inline)
 *   2. The cron handler (`src/index.ts`, `trigger.kind === "schedule"`)
 *   3. The timer handler (`src/index.ts`, `trigger.kind === "timer"`)
 *
 * Async mode is gone — future work is always expressed as a timer now. Inline
 * sub-agent replies are collected through a caller-provided `replyCollector`
 * slot so the parent can preserve dispatch-call order when flushing (see
 * `TurnContext.pendingSubReplies`). Top-level runs (schedule/timer/message)
 * pass no collector, so their reply tools fall through to WhatsApp directly.
 */

import { settings } from "@/infra/config";
import { log } from "@/infra/logger";
import type { Trigger, TurnContext } from "@/pipeline/core";
import { executeAgent } from "@/pipeline/core";
import { agentRegistry, getOrLoadAgent } from "@/pipeline/agents";
import { buildTurnConfig } from "@/pipeline/overrides";
import { getVariables } from "@/primitives/variables";

export interface DispatchOptions {
	agent: string;
	prompt: string;
	overrides?: string[];
	chatId: string;
	/** What kicked off this dispatch — schedule, timer, message, or another agent. */
	trigger: Trigger;
	/** Chain depth — incremented on each recursive dispatch. Enforces maxChainDepth. */
	depth?: number;
	/**
	 * Ordered slot this run's reply(s) fill. Set by the dispatch tool; the
	 * sub's reply tool pushes into it instead of enqueuing to WhatsApp. Omit
	 * for top-level runs (cron/timer) so their replies go direct.
	 */
	replyCollector?: string[];
}

async function resolveAgent(name: string) {
	const cached = agentRegistry.get(name);
	if (cached) return cached;
	return getOrLoadAgent(name);
}

export async function dispatch(
	opts: DispatchOptions,
): Promise<string | undefined> {
	const {
		agent: agentName,
		prompt,
		chatId,
		trigger,
		depth = 0,
		replyCollector,
	} = opts;

	if (depth >= settings.agent.maxChainDepth) {
		log.warn(
			`[dispatch] max chain depth (${depth}) reached for @${agentName}, stopping`,
		);
		return undefined;
	}

	log.info(`[dispatch] @${agentName} (trigger: ${trigger.kind})`);
	const def = await resolveAgent(agentName);

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
		dispatchContext: { prompt },
		pendingSubReplies: [],
		...(replyCollector ? { _replyCollector: replyCollector } : {}),
	};

	await executeAgent({
		turn: partialTurn,
		def,
		variables: getVariables(),
	});

	return replyCollector && replyCollector.length > 0
		? replyCollector.join("\n\n")
		: undefined;
}
