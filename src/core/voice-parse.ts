const FILLER_WORDS = new Set(["and", "with", "also"]);

/** Build map of spoken multi-word forms to canonical flag names (e.g. "no tools" → "no-tools"). */
function buildSpokenFlagMap(
	knownFlags: ReadonlySet<string>,
): Map<string, string> {
	const map = new Map<string, string>();
	for (const flag of knownFlags) {
		if (flag.includes("-")) {
			map.set(flag.replace(/-/g, " "), flag);
		}
	}
	return map;
}

function rewriteAgentPrefix(
	text: string,
	knownAgents: ReadonlySet<string>,
	triggers: readonly string[],
): string {
	const lower = text.toLowerCase();

	for (const trigger of triggers) {
		const prefix = `${trigger} `;
		if (!lower.startsWith(prefix)) continue;

		const afterTrigger = text.slice(prefix.length);
		const match = afterTrigger.match(/^([\w-]+)[,.]?\s*(.*)/s);
		if (!match?.[1]) continue;

		const candidate = match[1].toLowerCase();
		if (knownAgents.has(candidate)) {
			const remainder = match[2] ?? "";
			return remainder ? `@${candidate} ${remainder}` : `@${candidate}`;
		}
	}

	// Bare agent name at start: "fitness, help me" or "fitness help me"
	const bareMatch = lower.match(/^([\w-]+)[,]\s*/);
	if (bareMatch?.[1] && knownAgents.has(bareMatch[1])) {
		const remainder = text.slice(bareMatch[0].length);
		return remainder ? `@${bareMatch[1]} ${remainder}` : `@${bareMatch[1]}`;
	}

	return text;
}

function rewriteFlagSuffix(
	text: string,
	knownFlags: ReadonlySet<string>,
	triggers: readonly string[],
): string {
	// Strip trailing punctuation for matching
	const stripped = text.replace(/[.?!]+$/, "");
	const lower = stripped.toLowerCase();

	// Sort triggers longest-first to avoid partial matches
	const sorted = [...triggers].sort((a, b) => b.length - a.length);

	for (const trigger of sorted) {
		const idx = lower.lastIndexOf(trigger);
		if (idx === -1) continue;

		// Trigger must be preceded by whitespace (or be at start)
		if (idx > 0 && stripped[idx - 1] !== " ") continue;

		const beforeTrigger = stripped.slice(0, idx).trimEnd();
		const afterTrigger = stripped.slice(idx + trigger.length).trim();
		if (!afterTrigger) continue;

		const words = afterTrigger
			.split(/[\s,]+/)
			.filter((w) => w && !FILLER_WORDS.has(w.toLowerCase()));
		if (words.length === 0) continue;

		const spokenMap = buildSpokenFlagMap(knownFlags);
		const matched: string[] = [];
		let i = 0;

		while (i < words.length) {
			// Try two-word match first (for hyphenated flags like "no tools" → "no-tools")
			if (i + 1 < words.length) {
				const pair = `${(words[i] as string).toLowerCase()} ${(words[i + 1] as string).toLowerCase()}`;
				const canonical = spokenMap.get(pair);
				if (canonical) {
					matched.push(canonical);
					i += 2;
					continue;
				}
			}

			// Single-word match
			const single = (words[i] as string).toLowerCase();
			if (knownFlags.has(single)) {
				matched.push(single);
			}
			i++;
		}

		if (matched.length === 0) continue;

		const flagTokens = matched.map((f) => `!${f}`).join(" ");
		return beforeTrigger ? `${beforeTrigger} ${flagTokens}` : flagTokens;
	}

	return text;
}

export function rewriteVoiceTranscript(
	text: string,
	knownAgents: ReadonlySet<string>,
	knownFlags: ReadonlySet<string>,
	agentTriggers: readonly string[],
	flagTriggers: readonly string[],
): string {
	if (!text) return text;

	let result = rewriteAgentPrefix(text, knownAgents, agentTriggers);
	result = rewriteFlagSuffix(result, knownFlags, flagTriggers);

	return result;
}
