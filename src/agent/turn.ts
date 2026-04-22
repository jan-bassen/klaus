import { resolveAgentDefaults, type TurnConfig } from "@/pipeline/overrides";
import type { AgentDefinition, InboundMessage, TurnContext } from "@/types";
import { assembleVariables } from "@/variables";

export interface BuildTurnOpts {
	chatId: string;
	def: AgentDefinition;
	message?: InboundMessage;
	dispatchContext?: TurnContext["dispatchContext"];
	overrides?: Record<string, boolean>;
	/** Partial TurnConfig from resolved `!overrides` presets (pipeline path). */
	presetConfig?: TurnConfig;
	messageId?: string;
	/** Collects reply content for inline-dispatched agents instead of sending to WhatsApp. */
	replyCollector?: string[];
}

/**
 * Shared "resolve defaults → partial turn → assemble variables" helper used by
 * the pipeline, retry, and both dispatch paths (inline + queue worker).
 */
export async function buildTurn(opts: BuildTurnOpts): Promise<TurnContext> {
	const config = resolveAgentDefaults(opts.presetConfig ?? {}, opts.def);

	const partialTurn: Omit<TurnContext, "vars"> = {
		chatId: opts.chatId,
		agent: opts.def,
		overrides: opts.overrides ?? {},
		config,
		messageRefs: {},
		...(opts.message ? { message: opts.message } : {}),
		...(opts.dispatchContext ? { dispatchContext: opts.dispatchContext } : {}),
		...(opts.messageId ? { messageId: opts.messageId } : {}),
		...(opts.replyCollector ? { _replyCollector: opts.replyCollector } : {}),
	};

	const vars = await assembleVariables(partialTurn);
	return { ...partialTurn, vars };
}
