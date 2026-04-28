import { LlmTimeoutError } from "@/pipeline/core";
import { renderTemplate } from "@/pipeline/prompts";

type ErrorKind = "timeout" | "rate_limit" | "too_long" | "generic";

interface ErrorInfo {
	kind: ErrorKind;
	/** First non-empty line of the underlying error, capped to 120 chars. */
	message: string;
}

/** Classify an arbitrary thrown value into a kind + cleaned message. */
function mapError(err: unknown): ErrorInfo {
	if (err instanceof LlmTimeoutError) return { kind: "timeout", message: "" };

	const msg = err instanceof Error ? err.message : String(err);

	if (/rate.?limit/i.test(msg)) return { kind: "rate_limit", message: "" };
	if (/prompt is too long/i.test(msg)) return { kind: "too_long", message: "" };

	return {
		kind: "generic",
		message: (msg.split("\n")[0] ?? msg).slice(0, 120),
	};
}

/**
 * Map + render a thrown value through `error-message.md`. Falls back to a
 * built-in string if the template is missing so error reporting always works.
 */
export function formatUserError(err: unknown): string {
	const info = mapError(err);
	try {
		return renderTemplate("error-message", { ...info });
	} catch {
		return defaultErrorMessage(info);
	}
}

function defaultErrorMessage(info: ErrorInfo): string {
	switch (info.kind) {
		case "timeout":
			return "The AI model timed out — please try again.";
		case "rate_limit":
			return "Too many requests right now — please try again in a moment.";
		case "too_long":
			return "Your conversation got too long for the model — try starting fresh.";
		default:
			return `Something went wrong: ${info.message}`;
	}
}
