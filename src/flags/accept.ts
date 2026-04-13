import type { FlagDef } from "./index";

export const acceptFlag: FlagDef = {
	name: "accept",
	aliases: ["a"],
	description: "Auto-accept confirmation prompts",
	overrides: { autoAccept: true },
};
