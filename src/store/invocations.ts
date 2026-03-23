import { z } from "zod";
import { settings } from "@/settings";
import { appendJsonl } from "./jsonl";

export const InvocationRecordSchema = z.object({
	agent: z.string(),
	model: z.string(),
	messageId: z.string().optional(),
	systemPrompt: z.string().optional(),
	userMessage: z.string().optional(),
	steps: z.array(z.unknown()),
	promptTokens: z.number(),
	completionTokens: z.number(),
	durationMs: z.number(),
	createdAt: z.string(),
});

export type InvocationRecord = z.infer<typeof InvocationRecordSchema>;

/** Append an invocation trace to the daily JSONL file. */
export async function recordInvocation(
	record: Omit<InvocationRecord, "createdAt">,
): Promise<void> {
	await appendJsonl(`${settings.dataDir}/invocations`, "invocations", {
		...record,
		createdAt: new Date().toISOString(),
	});
}
