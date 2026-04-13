import type { FlagDef } from "./index";

export const claudeFlag: FlagDef = {
	name: "claude",
	description: "Use Claude provider for this turn",
	overrides: { provider: "claude" },
};

export const chatgptFlag: FlagDef = {
	name: "chatgpt",
	description: "Use ChatGPT provider for this turn",
	overrides: { provider: "chatgpt" },
};

export const geminiFlag: FlagDef = {
	name: "gemini",
	description: "Use Gemini provider for this turn",
	overrides: { provider: "gemini" },
};
