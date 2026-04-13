import type { FlagDef } from "./index";

export const ghostFlag: FlagDef = {
	name: "ghost",
	aliases: ["g"],
	description: "Ephemeral call — no history, auto-delete",
	overrides: { ghost: true, skipHistory: true },
};
