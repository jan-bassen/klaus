import type { FlagDef } from "./index";

export const cleanFlag: FlagDef = {
	name: "clean",
	aliases: ["cl"],
	description: "Call without conversation history",
	overrides: { skipHistory: true },
};
