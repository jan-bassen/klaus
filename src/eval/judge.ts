import { z } from "zod";
import { callModel } from "@/agent/model";

const JUDGE_SYSTEM = `You are an eval judge for an AI assistant. You will receive a JSON object with:
- systemPrompt: the assistant's system prompt
- userMessage: the user's input
- response: the assistant's reply
- criteria: list of requirements the response must satisfy

For each criterion, judge PASS or FAIL. Be strict but fair — the criterion must be clearly met, not just arguably present.

Respond with ONLY a JSON array (no markdown fences, no commentary):
[{"criterion": "...", "pass": true, "reason": "one sentence"}]`;

const JudgmentSchema = z.array(
	z.object({
		criterion: z.string(),
		pass: z.boolean(),
		reason: z.string(),
	}),
);

export interface Judgment {
	criterion: string;
	pass: boolean;
	reason: string;
}

export async function judge(args: {
	systemPrompt: string;
	userMessage: string;
	response: string;
	criteria: string[];
}): Promise<{ ok: true; judgments: Judgment[] } | { ok: false; raw: string }> {
	const result = await callModel({
		tier: "small",
		temperature: 0,
		system: JUDGE_SYSTEM,
		messages: [
			{ role: "user", content: [{ type: "text", text: JSON.stringify(args) }] },
		],
	});

	const cleaned = result.content
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```\s*$/, "")
		.trim();

	try {
		const parsed = JudgmentSchema.parse(JSON.parse(cleaned));
		return { ok: true, judgments: parsed };
	} catch {
		return { ok: false, raw: result.content };
	}
}
