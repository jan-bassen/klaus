import { config } from "@/config";

const overrides = new Map<string, string>();

export function getDefaultAgent(chatId: string): string {
	return overrides.get(chatId) ?? config.defaultAgent;
}

export function setDefaultAgent(chatId: string, agent: string | null): void {
	if (agent === null) overrides.delete(chatId);
	else overrides.set(chatId, agent);
}

export function _resetDefaultsForTest(): void {
	overrides.clear();
}
