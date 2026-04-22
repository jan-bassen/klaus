import type { ModelMessage } from "ai";
import { Output } from "ai";
import { resolveProvider, settings } from "@/config";
import { log } from "@/logger";
import { appendTrace } from "@/store/conversation";
import { REPLY_TOOL_NAME } from "@/tools/reply";
import type { AgentDefinition, TurnContext } from "@/types";
import { buildConversationMessages } from "./history";
import { buildUserContent } from "./message";
import { callModel, type ModelCallStep } from "./model";
import {
	PersistentOutputSchema,
	schedulePersistentTimer,
	toTraceSteps,
} from "./persistent";
import { buildSystemPrompt, resolveSampling } from "./prompt";
import { assembleTools } from "./tools";

export interface AgentRunResult {
	usage: { promptTokens: number; completionTokens: number };
	durationMs: number;
	steps: ModelCallStep[];
	model: string;
	provider: string;
	tier: string;
	conversationMessages: number;
	systemPrompt: string;
	userMessage: string;
	replyContent: string;
}

/**
 * Run a single agent turn:
 *   build tools → build history → build user content → build system prompt →
 *   callModel → persist trace → reschedule (if persistent) → return metadata.
 *
 * Each step is a focused module — this file only composes them.
 */
export async function runAgent(
	turn: TurnContext,
	def: AgentDefinition,
): Promise<AgentRunResult> {
	const providerCfg = resolveProvider(turn.config?.provider);
	const tier = turn.config?.modelTier ?? def.modelTier;
	const modelId = providerCfg[tier];
	const toolChoice = turn.config?.toolChoice;

	const { allTools, initialActive, prepareStep } = assembleTools(def, turn);
	const sampling = resolveSampling(turn.config, turn.config?.provider);

	log.info(
		`[agent] calling ${modelId} via ${providerCfg.sdk} for @${def.name}`,
	);

	try {
		const { messages: historyMessages, messageRefs } = turn.config?.skipHistory
			? { messages: [] as ModelMessage[], messageRefs: {} }
			: await buildConversationMessages(turn);

		// messageRefs are consumed by the reply/react tools.
		Object.assign(turn.messageRefs, messageRefs);

		const userContent = await buildUserContent(turn);
		const messages: ModelMessage[] = [
			...historyMessages,
			{ role: "user", content: userContent },
		];

		const promptRaw = await Bun.file(def.promptPath).text();
		const promptBody = promptRaw.replace(/^---\n[\s\S]*?\n---\n?/, "");
		const system = buildSystemPrompt(promptBody, turn.vars);

		const hasTools = Object.keys(allTools).length > 0;
		const activeTools =
			toolChoice === "none" ? [REPLY_TOOL_NAME] : initialActive;

		const result = await callModel({
			tier,
			provider: turn.config?.provider,
			agentName: def.name,
			chatId: turn.chatId,
			...(turn.messageId ? { messageId: turn.messageId } : {}),
			system,
			messages,
			...(sampling.temperature !== undefined
				? { temperature: sampling.temperature }
				: {}),
			...(sampling.topP !== undefined ? { topP: sampling.topP } : {}),
			...(sampling.providerOptions
				? { providerOptions: sampling.providerOptions }
				: {}),
			...(toolChoice === "required" ? { toolChoice: "required" as const } : {}),
			...(hasTools
				? {
						tools: allTools,
						activeTools,
						...(toolChoice !== "none" ? { prepareStep } : {}),
					}
				: {}),
			...(def.persistent
				? { output: Output.object({ schema: PersistentOutputSchema }) }
				: {}),
		});

		// Persist trace for multi-turn replay (fire-and-forget)
		if (turn.messageId && result.steps.length > 0) {
			const traceSteps = toTraceSteps(result.steps);
			if (traceSteps.length > 0) {
				appendTrace(turn.messageId, traceSteps).catch((err) =>
					log.warn("[agent] failed to persist trace", {
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			}
		}

		// Persistent agents: schedule next run from structured output
		if (def.persistent) {
			const parsed = PersistentOutputSchema.safeParse(result.output);
			if (parsed.success) {
				await schedulePersistentTimer(
					def.name,
					turn.chatId,
					parsed.data.nextRun,
					parsed.data.objective,
				);
			} else {
				log.warn(
					`[agent] persistent output parse failed for @${def.name}, using fallback`,
				);
				await schedulePersistentTimer(
					def.name,
					turn.chatId,
					settings.persistent.defaultNextRun,
					turn.dispatchContext?.objective ?? "Continue persistent check-in",
				);
			}
		}

		// Extract reply content from reply tool calls for logging
		const replyContent = result.steps
			.flatMap((s) => s.toolCalls)
			.filter((tc) => tc.toolName === REPLY_TOOL_NAME)
			.map((tc) => {
				const content = tc.args?.content;
				return typeof content === "string" ? content : "";
			})
			.join("\n---\n");

		const userMessageStr =
			typeof userContent === "string"
				? userContent
				: JSON.stringify(userContent);

		return {
			usage: result.usage,
			durationMs: result.durationMs,
			steps: result.steps,
			model: modelId,
			provider: providerCfg.sdk,
			tier,
			conversationMessages: historyMessages.length,
			systemPrompt: system,
			userMessage: userMessageStr,
			replyContent,
		};
	} catch (err) {
		// Persistent agents must always reschedule, even on failure
		if (def.persistent) {
			await schedulePersistentTimer(
				def.name,
				turn.chatId,
				settings.persistent.defaultNextRun,
				turn.dispatchContext?.objective ?? "Continue persistent check-in",
			).catch((timerErr) =>
				log.error(
					`[agent] failed to schedule recovery timer for @${def.name}`,
					{
						error:
							timerErr instanceof Error ? timerErr.message : String(timerErr),
					},
				),
			);
		}
		log.error(`[agent] model call failed for @${def.name}`, {
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
		});
		throw err;
	}
}
