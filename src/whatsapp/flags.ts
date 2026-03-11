import { getKnownFlags } from "@/context/flags";
import type { InboundMessage } from "@/types";

const knownFlags = new Set(getKnownFlags());

/** Returns the flag name if a token is a recognized !flag, otherwise null. */
function flagName(token: string): string | null {
	if (!token.startsWith("!") || token.length <= 1) return null;
	const name = token.slice(1);
	return knownFlags.has(name) ? name : null;
}

/**
 * Parse !flags from a message and return the active flags.
 * Only recognizes flags defined in src/context/flags.ts.
 */
export function parseFlags(msg: InboundMessage): Record<string, boolean> {
	if (!msg.text) return {};

	const flags: Record<string, boolean> = {};
	for (const token of msg.text.split(/\s+/)) {
		const name = flagName(token);
		if (name) flags[name] = true;
	}
	return flags;
}

/** Remove recognized !flag tokens from text and collapse whitespace. */
export function stripFlags(text: string): string {
	return text
		.split(/\s+/)
		.filter((token) => flagName(token) === null)
		.join(" ")
		.trim();
}
