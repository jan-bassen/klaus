import type { FlagDef } from "./index";

export const lowFlag: FlagDef = {
	name: "low",
	aliases: ["lo"],
	description: "Low reasoning effort (faster, cheaper)",
	overrides: { reasoningEffort: "low" },
};

export const highFlag: FlagDef = {
	name: "high",
	aliases: ["hi"],
	description: "High reasoning effort (slower, more thorough)",
	overrides: { reasoningEffort: "high" },
};

export const fastFlag: FlagDef = {
	name: "fast",
	aliases: ["f"],
	description: "Fast inference mode (provider-dependent)",
	overrides: { fast: true },
};
