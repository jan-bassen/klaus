import { config } from "./config";
import { getYamlSettings } from "./core/settings-loader";

export type VaultPermission = "none" | "read" | "append" | "full";

export interface VaultFolder {
	/** Relative to vault root, e.g. "Leben". Empty string "" for root-level files. */
	path: string;
	/** Always-on permission level. */
	default: VaultPermission;
	/** Elevated permission available via WhatsApp reaction confirmation. */
	request?: VaultPermission | undefined;
}

export type ModelTier = "default" | "low" | "high" | "tts" | "stt" | "vision";

/** Model tier names suitable for z.enum(). */
export const modelTiers: [ModelTier, ...ModelTier[]] = [
	"default",
	"low",
	"high",
	"tts",
	"stt",
	"vision",
];

export const settings = {
	get models() {
		return getYamlSettings().models;
	},
	get context() {
		return getYamlSettings().context;
	},
	get rateLimits() {
		return getYamlSettings().rateLimits;
	},
	get tts() {
		return getYamlSettings().tts;
	},
	get stt() {
		return getYamlSettings().stt;
	},
	get retries() {
		return getYamlSettings().retries;
	},
	get send() {
		return getYamlSettings().send;
	},
	get llm() {
		return getYamlSettings().llm;
	},
	get defaultAgent() {
		return getYamlSettings().defaultAgent;
	},
	get locale() {
		return getYamlSettings().locale;
	},
	get timezone() {
		return getYamlSettings().timezone;
	},
	get dispatch() {
		return getYamlSettings().dispatch;
	},
	get persistent() {
		return getYamlSettings().persistent;
	},
	get watcher() {
		return getYamlSettings().watcher;
	},
	get vision() {
		return getYamlSettings().vision;
	},
	get whatsapp() {
		return getYamlSettings().whatsapp;
	},
	vault: {
		get root() {
			return config.vault.root;
		},
		get internal() {
			return config.vault.internal;
		},
		get folders() {
			return getYamlSettings().vault.folders;
		},
		get internalPermission() {
			return getYamlSettings().vault.internalPermission;
		},
		get maxListEntries() {
			return getYamlSettings().vault.maxListEntries;
		},
		get internalPath() {
			return config.vault.internalPath;
		},
		get agentsDir() {
			return config.vault.agentsDir;
		},
		get skillsDir() {
			return config.vault.skillsDir;
		},
		get snippetsDir() {
			return config.vault.snippetsDir;
		},
		get flagsDir() {
			return config.vault.flagsDir;
		},
	},
	get dataDir() {
		return config.dataDir;
	},
	log: config.log,
	startup: config.startup,
};
