import type { FlagDef } from "./index";

export const creativeFlag: FlagDef = {
	name: "creative",
	aliases: ["cr"],
	description: "Use high topP (diverse sampling)",
	overrides: { topPPreset: "creative" },
};

export const rigidFlag: FlagDef = {
	name: "rigid",
	aliases: ["r"],
	description: "Use low topP (focused sampling)",
	overrides: { topPPreset: "rigid" },
};
