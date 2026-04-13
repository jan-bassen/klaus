import type { FlagDef } from "./index";

export const noToolsFlag: FlagDef = {
	name: "no-tools",
	aliases: ["nt"],
	description: "Disable all tools except reply",
	overrides: { toolChoice: "none" },
};

export const useToolsFlag: FlagDef = {
	name: "use-tools",
	aliases: ["ut"],
	description: "Force tool use (model must call a tool)",
	overrides: { toolChoice: "required" },
};
