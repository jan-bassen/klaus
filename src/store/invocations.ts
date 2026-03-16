import { config } from "@/config";
import { appendJsonl } from "./jsonl";

export interface InvocationRecord {
	agent: string;
	model: string;
	messageId?: string;
	taskId?: string;
	systemPrompt?: string;
	userMessage?: string;
	steps: unknown[];
	promptTokens: number;
	completionTokens: number;
	durationMs: number;
	createdAt: string;
}

/** Append an invocation trace to the daily JSONL file. */
export async function recordInvocation(
	record: Omit<InvocationRecord, "createdAt">,
): Promise<void> {
	await appendJsonl(`${config.dataDir}/invocations`, "invocations", {
		...record,
		createdAt: new Date().toISOString(),
	});
}
