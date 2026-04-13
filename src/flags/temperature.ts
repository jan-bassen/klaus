import type { FlagDef } from "./index";

export const coldFlag: FlagDef = {
	name: "cold",
	aliases: ["c"],
	description: "Set temperature to low (deterministic)",
	overrides: { temperaturePreset: "cold" },
};

export const hotFlag: FlagDef = {
	name: "hot",
	aliases: ["h"],
	description: "Set temperature to high (creative)",
	overrides: { temperaturePreset: "hot" },
};
