import { z } from "zod";
import { settings } from "@/config";
import { log } from "@/logger";
import type { TraceStep } from "@/store/conversation";
import { addTimer, listTimers, removeTimer } from "@/store/timers";
import { REPLY_TOOL_NAME } from "@/tools/reply";
import { parseRunAt } from "@/tools/sets/dispatch";
import type { ModelCallStep } from "./model";

export const PersistentOutputSchema = z.object({
	nextRun: z
		.string()
		.describe("When to run next: delay string ('2h','1d') or ISO datetime"),
	objective: z.string().describe("What the next run should focus on"),
});

export type PersistentOutput = z.infer<typeof PersistentOutputSchema>;

/** Clamp an ISO run-at string to the configured min/max bounds. */
export function clampNextRun(isoRunAt: string): string {
	const runAtMs = new Date(isoRunAt).getTime();
	const nowMs = Date.now();
	const delayMs = runAtMs - nowMs;
	const clamped = Math.max(
		settings.persistent.minNextRunMs,
		Math.min(delayMs, settings.persistent.maxNextRunMs),
	);
	if (clamped !== delayMs) {
		return new Date(nowMs + clamped).toISOString();
	}
	return isoRunAt;
}

/** Cancel any existing persistent timers for this agent+chat to prevent accumulation. */
async function cancelExistingPersistentTimers(
	agentName: string,
	chatId: string,
): Promise<void> {
	const existing = listTimers().filter(
		(t) =>
			t.agentName === agentName &&
			t.chatId === chatId &&
			t.createdBy === `persistent:${agentName}`,
	);
	for (const t of existing) {
		await removeTimer(t.id);
	}
}

/** Schedule the next persistent run — cancels any prior ones first. */
export async function schedulePersistentTimer(
	agentName: string,
	chatId: string,
	nextRun: string,
	objective: string,
): Promise<void> {
	await cancelExistingPersistentTimers(agentName, chatId);
	const absoluteRunAt = parseRunAt(nextRun);
	const clampedRunAt = clampNextRun(absoluteRunAt);
	await addTimer({
		id: crypto.randomUUID(),
		agentName,
		chatId,
		objective,
		runAt: clampedRunAt,
		createdBy: `persistent:${agentName}`,
		createdAt: new Date().toISOString(),
	});
	log.info(`[agent] scheduled next run for @${agentName} at ${clampedRunAt}`);
}

/**
 * Convert model call steps to persisted trace steps.
 * Filters out reply tool calls and drops orphaned calls (no matching result)
 * so replayed traces never produce "Tool result is missing" API errors.
 */
export function toTraceSteps(steps: ModelCallStep[]): TraceStep[] {
	const result: TraceStep[] = [];

	for (const step of steps) {
		const allCalls = step.toolCalls.filter(
			(tc) => tc.toolName !== REPLY_TOOL_NAME,
		);
		const allResults = step.toolResults.filter(
			(tr) => tr.toolName !== REPLY_TOOL_NAME,
		);

		const resultIds = new Set(allResults.map((tr) => tr.toolCallId));
		const pairedCalls = allCalls.filter((tc) => resultIds.has(tc.toolCallId));

		const toolCalls = pairedCalls.map((tc) => ({
			toolCallId: tc.toolCallId,
			toolName: tc.toolName,
			args: JSON.stringify(tc.args),
		}));
		const toolResults = pairedCalls.map((tc) => {
			const tr = allResults.find((r) => r.toolCallId === tc.toolCallId) ?? {
				toolCallId: tc.toolCallId,
				toolName: tc.toolName,
				result: null,
			};
			return {
				toolCallId: tr.toolCallId,
				toolName: tr.toolName,
				result: JSON.stringify(tr.result),
			};
		});
		const reasoning = step.reasoning || undefined;

		if (reasoning || toolCalls.length > 0) {
			result.push({ reasoning, toolCalls, toolResults });
		}
	}

	return result;
}
