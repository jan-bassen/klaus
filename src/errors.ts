import { LlmTimeoutError } from "@/agent/model";

export function formatUserError(err: unknown): string {
	if (err instanceof LlmTimeoutError) {
		return "The AI model timed out — please try again.";
	}
	const msg = err instanceof Error ? err.message : String(err);
	if (/rate.?limit/i.test(msg)) {
		return "Too many requests right now — please try again in a moment.";
	}
	if (/prompt is too long/i.test(msg)) {
		return "Your conversation got too long for the model — try starting fresh.";
	}
	const clean = (msg.split("\n")[0] ?? msg).slice(0, 120);
	return `Something went wrong: ${clean}`;
}
