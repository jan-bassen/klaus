import { z } from "zod";
import { settings } from "@/settings";
import { appendJsonl } from "./jsonl";

const PipelineStepSchema = z.object({
	reasoning: z.string().optional(),
	toolCalls: z
		.array(
			z.object({
				toolName: z.string(),
				args: z.string(),
			}),
		)
		.default([]),
	toolResults: z
		.array(
			z.object({
				toolName: z.string(),
				result: z.string(),
			}),
		)
		.default([]),
	finishReason: z.string().optional(),
	usage: z
		.object({
			inputTokens: z.number().optional(),
			outputTokens: z.number().optional(),
		})
		.optional(),
});

export const TurnLogSchema = z.object({
	// Identity
	messageId: z.string().optional(),
	chatId: z.string(),
	agent: z.string(),
	createdAt: z.string(),

	// Inbound context
	rawText: z.string().optional(),
	flags: z.array(z.string()).default([]),
	mediaType: z.string().optional(),

	// Routing
	provider: z.string(),
	model: z.string(),
	tier: z.string(),

	// Prompts (as sent to model)
	systemPrompt: z.string().optional(),
	userMessage: z.string().optional(),

	// Context assembly
	contextTokens: z.number(),
	conversationMessages: z.number(),

	// LLM execution
	steps: z.array(PipelineStepSchema),
	promptTokens: z.number(),
	completionTokens: z.number(),
	durationMs: z.number(),

	// Outcome
	replyContent: z.string().optional(),
	error: z.string().optional(),
});

export type TurnLog = z.infer<typeof TurnLogSchema>;

/** Convert raw model call steps into structured pipeline log steps with full detail. */
export function toLogSteps(
	rawSteps: Array<{
		reasoning: string;
		toolCalls: Array<{
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
		}>;
		toolResults: Array<{
			toolCallId: string;
			toolName: string;
			result: unknown;
		}>;
		finishReason?: string;
		usage?: { inputTokens?: number; outputTokens?: number };
	}>,
): TurnLog["steps"] {
	return rawSteps.map((step) => ({
		...(step.reasoning ? { reasoning: step.reasoning } : {}),
		toolCalls: step.toolCalls.map((tc) => ({
			toolName: tc.toolName,
			args: JSON.stringify(tc.args),
		})),
		toolResults: step.toolResults.map((tr) => ({
			toolName: tr.toolName,
			result: JSON.stringify(tr.result),
		})),
		...(step.finishReason ? { finishReason: step.finishReason } : {}),
		...(step.usage ? { usage: step.usage } : {}),
	}));
}

/** Append a turn log entry to the daily JSONL file. */
export async function recordTurnLog(
	record: Omit<TurnLog, "createdAt">,
): Promise<void> {
	await appendJsonl(`${settings.dataDir}/logs`, "pipeline", {
		...record,
		createdAt: new Date().toISOString(),
	});
}
