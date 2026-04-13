import type { AssistantContent, ModelMessage, ToolContent } from "ai";
import { settings } from "@/config";
import {
	type ConversationMessage,
	getConversation,
	getTraces,
	type TraceStep,
} from "@/store/conversation";
import type { TurnContext } from "@/types";

const CHARS_PER_TOKEN = settings.context.charsPerToken;
const MAX_REASONING_CHARS = settings.context.maxReasoningChars;
const MAX_TOOL_RESULT_CHARS = settings.context.maxToolResultChars;
const TRACE_DEPTH = settings.context.traceDepth;
const MAX_SUMMARY_ARG_CHARS = 40;

/**
 * Produce a compact one-line summary of tool usage across trace steps.
 * Example: "[Used vault.read("Training/Plan.md"), vault.search("workout") → replied]"
 */
function summarizeTrace(steps: TraceStep[]): string {
	const calls: string[] = [];
	for (const step of steps) {
		for (const tc of step.toolCalls) {
			if (tc.toolName === "reply") continue;
			let argSnippet = "";
			try {
				const parsed = JSON.parse(tc.args);
				const firstVal = Object.values(parsed)[0];
				if (firstVal !== undefined) {
					const s = String(firstVal);
					argSnippet =
						s.length > MAX_SUMMARY_ARG_CHARS
							? `${s.slice(0, MAX_SUMMARY_ARG_CHARS)}…`
							: s;
				}
			} catch {
				// unparseable args — skip snippet
			}
			calls.push(argSnippet ? `${tc.toolName}("${argSnippet}")` : tc.toolName);
		}
	}
	if (calls.length === 0) return "";
	return `[Used ${calls.join(", ")} → replied]`;
}

/**
 * Build the conversation messages array for the SDK, reconstructing full
 * multi-step traces for recent turns so the model sees its own reasoning
 * and tool use from prior turns.
 *
 * Returns { messages, messageRefs } — messageRefs maps #label → externalId
 * for reply/react tools.
 */
export async function buildConversationMessages(
	turn: Omit<TurnContext, "assembled">,
): Promise<{
	messages: ModelMessage[];
	messageRefs: Record<string, { externalId: string; role: string }>;
}> {
	if (!turn.message) {
		return { messages: [], messageRefs: {} };
	}

	const limit =
		turn.agent.conversationLimit ?? settings.context.defaultConversationLimit;
	const allMessages = await getConversation();
	const traces = await getTraces();

	// Exclude the current inbound message from history
	const filtered = turn.message?.id
		? allMessages.filter((m) => m.externalId !== turn.message?.id)
		: allMessages;

	const recent = filtered.slice(-limit);

	// Budget-aware inclusion (work backwards)
	// Only count full trace tokens for turns within TRACE_DEPTH;
	// older turns get compact summaries (negligible cost).
	const budget = settings.context.conversationTokens;
	const showTools = turn.agent.showToolsInContext;
	let tokenCount = 0;
	const included: ConversationMessage[] = [];

	// Pre-count user messages for trace depth threshold
	let recentUserCount = 0;
	for (let i = recent.length - 1; i >= 0; i--) {
		if (recent[i]?.role === "user") recentUserCount++;
	}
	const budgetTraceThreshold = recentUserCount - TRACE_DEPTH;
	let budgetUsersSeen = 0;

	for (let i = recent.length - 1; i >= 0; i--) {
		const row = recent[i];
		if (!row || !row.content) continue;
		if (row.role === "user") budgetUsersSeen++;
		const msgTokens = Math.ceil(row.content.length / CHARS_PER_TOKEN);
		// Only count full trace tokens for recent turns within TRACE_DEPTH
		let traceTokens = 0;
		if (showTools && budgetUsersSeen <= TRACE_DEPTH) {
			const trace = traces.get(row.id);
			if (trace) {
				traceTokens = Math.ceil(
					trace.reduce(
						(sum, s) =>
							sum +
							(s.reasoning?.length ?? 0) +
							s.toolCalls.reduce((a, tc) => a + tc.args.length, 0) +
							s.toolResults.reduce(
								(a, tr) =>
									a + Math.min(tr.result.length, MAX_TOOL_RESULT_CHARS),
								0,
							),
						0,
					) / CHARS_PER_TOKEN,
				);
			}
		}
		if (tokenCount + msgTokens + traceTokens > budget) break;
		included.unshift(row);
		tokenCount += msgTokens + traceTokens;
	}

	const messages: ModelMessage[] = [];
	const messageRefs: Record<string, { externalId: string; role: string }> = {};

	// Determine which turns get full traces (last N user messages)
	let userMsgCount = 0;
	for (let i = included.length - 1; i >= 0; i--) {
		if (included[i]?.role === "user") userMsgCount++;
	}
	let usersSeen = 0;
	const traceThreshold = userMsgCount - TRACE_DEPTH;
	let lastUserId: string | undefined;

	for (let i = 0; i < included.length; i++) {
		const row = included[i];
		if (!row) continue;

		const label = i + 1;
		if (row.externalId) {
			messageRefs[String(label)] = {
				externalId: row.externalId,
				role: row.role,
			};
		}

		if (row.role === "user") {
			usersSeen++;
			lastUserId = row.id;
			messages.push({ role: "user", content: `[#${label}] ${row.content}` });
		} else {
			// Assistant turn — traces are keyed by the triggering user message ID
			const trace = lastUserId ? traces.get(lastUserId) : undefined;
			const useFullTrace = showTools && trace && usersSeen > traceThreshold;

			if (useFullTrace) {
				// Reconstruct multi-step messages from trace
				for (const step of trace) {
					const assistantParts: AssistantContent = [];

					if (step.reasoning) {
						assistantParts.push({
							type: "reasoning",
							text: step.reasoning.slice(0, MAX_REASONING_CHARS),
						});
					}

					// Only include tool calls that have a matching result — unpaired calls
					// cause the API to throw "Tool result is missing for tool call …"
					const resultMap = new Map(
						step.toolResults.map((tr) => [tr.toolCallId, tr]),
					);
					const pairedCalls = step.toolCalls.filter((tc) =>
						resultMap.has(tc.toolCallId),
					);

					for (const tc of pairedCalls) {
						assistantParts.push({
							type: "tool-call",
							toolCallId: tc.toolCallId,
							toolName: tc.toolName,
							input: JSON.parse(tc.args),
						});
					}

					if (assistantParts.length > 0) {
						messages.push({
							role: "assistant",
							content: assistantParts,
						});
					}

					if (pairedCalls.length > 0) {
						const toolParts: ToolContent = pairedCalls.map((tc) => {
							// pairedCalls is pre-filtered to IDs present in resultMap
							const tr = resultMap.get(tc.toolCallId) ?? {
								toolCallId: tc.toolCallId,
								toolName: tc.toolName,
								result: "",
							};
							return {
								type: "tool-result" as const,
								toolCallId: tr.toolCallId,
								toolName: tr.toolName,
								output: {
									type: "text" as const,
									value: tr.result.slice(0, MAX_TOOL_RESULT_CHARS),
								},
							};
						});
						messages.push({ role: "tool", content: toolParts });
					}
				}

				// Final text reply
				if (row.content) {
					messages.push({ role: "assistant", content: row.content });
				}
			} else {
				// Compact summary for older turns with traces, or flat text
				const summary = showTools && trace ? summarizeTrace(trace) : "";
				const text = summary
					? `${summary}\n${row.content ?? ""}`
					: (row.content ?? "");
				messages.push({ role: "assistant", content: text });
			}
		}
	}

	return { messages, messageRefs };
}
