import { getYamlSettings } from "./settings-loader";

const overrides = new Map<string, string>();

export function getActiveProvider(chatId?: string): string {
	if (chatId) {
		const override = overrides.get(chatId);
		if (override) return override;
	}
	return getYamlSettings().providers.active;
}

export function setActiveProvider(chatId: string, name: string | null): void {
	if (name === null) overrides.delete(chatId);
	else overrides.set(chatId, name);
}

/** Returns all provider names configured in settings (excluding "active"). */
export function getProviderNames(): string[] {
	const { active, ...rest } = getYamlSettings().providers;
	return Object.keys(rest);
}

export function _resetProviderDefaultsForTest(): void {
	overrides.clear();
}
