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

export function rewriteVoiceTranscript(
	text: string,
	knownAgents: ReadonlySet<string>,
	agentTriggers: readonly string[],
): string {
	if (!text) return text;
	return rewriteAgentPrefix(text, knownAgents, agentTriggers);
}
