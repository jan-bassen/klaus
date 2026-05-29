const pendingPrefixes = new Map<string, string>();

export function setNextPrefix(chatId: string, prefix: string): void {
	pendingPrefixes.set(chatId, prefix);
}

export function getNextPrefix(chatId: string): string | undefined {
	return pendingPrefixes.get(chatId);
}

export function clearNextPrefix(chatId: string): boolean {
	return pendingPrefixes.delete(chatId);
}

export function consumeNextPrefix(chatId: string): string | undefined {
	const prefix = getNextPrefix(chatId);
	if (prefix !== undefined) clearNextPrefix(chatId);
	return prefix;
}
