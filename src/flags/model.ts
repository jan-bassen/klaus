import type { FlagDef } from "./index";

export const smallFlag: FlagDef = {
	name: "small",
	aliases: ["s"],
	description: "Use low-tier model",
	overrides: { modelTier: "small" },
};

export const mediumFlag: FlagDef = {
	name: "medium",
	aliases: ["m"],
	description: "Use default-tier model",
	overrides: { modelTier: "medium" },
};

export const largeFlag: FlagDef = {
	name: "large",
	aliases: ["l"],
	description: "Use high-tier model",
	overrides: { modelTier: "large" },
};
